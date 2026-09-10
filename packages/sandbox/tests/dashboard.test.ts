import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	buildDashboard,
	emptyUsage,
	summarizeTranscript,
} from '../src/server/dashboard.ts';
import { canReadSession, ownsSession } from '../src/server/session-owner.ts';
import {
	appendChatEntry,
	createSession,
	deleteSession,
	listSessions,
	sessionPaths,
	updateSession,
	type ChatEntry,
} from '../src/server/sessions.ts';
import { hashSpec } from '../src/server/spec.ts';
import { writeDeliveryRecord } from '../src/server/delivery/record.ts';
import {
	filterWork,
	formatCost,
	formatTokens,
} from '../src/client/dashboard.ts';

const owner = {
	platformUrl: 'https://business.example',
	accountId: 'alice',
	tenantId: 'tenant-a',
};
function completion(
	sequence: number,
	costUsd: number | null,
	role = 'planner',
): ChatEntry {
	return {
		sequence,
		at: sequence,
		kind: 'event',
		role,
		event: {
			type: 'turn.completed',
			resumeId: null,
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			costUsd,
			finishReason: 'stop',
		},
	};
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-dashboard-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	const session = await createSession({
		workspaceRoot: root,
		owner,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Rezerwacja sal',
		brief: 'Rezerwacja sal spotkań',
		blueprint: 'new-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		install: false,
	});
	return { root, session };
}

describe('business dashboard', () => {
	it('counts each reported completion once, including planning and failed work, with price coverage', async () => {
		const entry = completion(1, 0.01);
		const failure = completion(3, null, 'backend-engineer');
		const summary = await summarizeTranscript([
			entry,
			entry,
			completion(2, 0),
			{
				...failure,
				event: {
					...(failure.event as Extract<
						NonNullable<ChatEntry['event']>,
						{ type: 'turn.completed' }
					>),
					finishReason: 'error',
				},
			},
		]);
		expect(summary.usage).toEqual({
			inputTokens: 30,
			outputTokens: 15,
			totalTokens: 45,
			reportedTurns: 3,
			missingUsage: 0,
			knownCostUsd: 0.01,
			pricedTurns: 2,
			unpricedTurns: 1,
		});
		expect(
			summary.phases.map((phase) => [phase.role, phase.usage.totalTokens]),
		).toEqual([
			['planner', 30],
			['backend-engineer', 15],
		]);
	});

	it('does not turn interrupted or synthetic failed usage into free work', async () => {
		const summary = await summarizeTranscript([
			{
				sequence: 1,
				at: 1,
				kind: 'event',
				role: 'planner',
				event: {
					type: 'turn.started',
					driver: 'fake',
					role: 'planner',
					resumeId: null,
				},
			},
			{
				sequence: 2,
				at: 2,
				kind: 'event',
				role: 'planner',
				event: {
					type: 'turn.completed',
					resumeId: null,
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					costUsd: null,
					finishReason: 'aborted',
				},
			},
			{
				sequence: 3,
				at: 3,
				kind: 'event',
				role: 'backend-engineer',
				event: {
					type: 'turn.started',
					driver: 'fake',
					role: 'backend-engineer',
					resumeId: null,
				},
			},
		]);
		expect(summary.usage.missingUsage).toBe(2);
		expect(formatTokens(summary.usage, 'pl')).toBe('?');
		expect(formatCost(summary.usage, 'pl')).toBe('?');
	});

	it('does not assign historical sessions or another account, tenant or platform to the user', async () => {
		const { session } = await fixture();
		expect(ownsSession(session, owner)).toBe(true);
		for (const other of [
			{ ...owner, accountId: 'bob' },
			{ ...owner, tenantId: 'tenant-b' },
			{ ...owner, platformUrl: 'https://other.example' },
		])
			expect(canReadSession(session, other, true)).toBe(false);
		const { owner: _owner, ...legacy } = session;
		expect(ownsSession(legacy, owner)).toBe(false);
		expect(canReadSession(legacy, owner, false)).toBe(false);
		expect(canReadSession(legacy, owner, true)).toBe(true);
	});

	it('withdraws the approved dashboard status when the spec changes and never calls a PR merged', async () => {
		const { root, session } = await fixture();
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		const spec = 'id: booking.core\nstatus: approved\n';
		await writeFile(join(paths.modulePath, 'spec/module.yaml'), spec);
		let current = await updateSession(root, session.id, {
			modules: [
				{ ...session.modules[0]!, specHash: hashSpec(spec), specApprovedAt: 1 },
			],
		});
		expect(
			(await buildDashboard(root, [current], owner, new Set())).rows[0]?.status,
		).toBe('approved');
		await writeFile(
			join(paths.modulePath, 'spec/module.yaml'),
			spec + 'name: Changed\n',
		);
		expect(
			(await buildDashboard(root, [current], owner, new Set())).rows[0]
				?.approvedModules,
		).toBe(0);
		current = await updateSession(root, session.id, {
			ejectedAt: 1,
			state: 'accepted',
		});
		await writeDeliveryRecord(paths.root, {
			target: 'git-pr',
			deliveredAt: 1,
			modules: ['booking.core'],
			branch: 'test',
			pullRequestUrl: 'https://example.test/review/1',
			compareUrl: null,
		});
		expect(
			(await buildDashboard(root, [current], owner, new Set())).rows[0]?.status,
		).toBe('review');
		await writeDeliveryRecord(paths.root, {
			target: 'workspace',
			deliveredAt: 1,
			modules: ['booking.core'],
			branch: null,
			pullRequestUrl: null,
			compareUrl: null,
		});
		expect(
			(await buildDashboard(root, [current], owner, new Set())).rows[0]?.status,
		).toBe('delivered');
		const archived = await buildDashboard(
			root,
			[{ ...current, archivedAt: 2 }],
			owner,
			new Set(),
		);
		expect(archived.rows[0]?.status).toBe('archived');
		expect(filterWork(archived.rows, '', '', false, 'pl')).toHaveLength(0);
		expect(filterWork(archived.rows, '', '', true, 'pl')).toHaveLength(1);
	});

	it('retains usage after deletion and excludes anonymous history from personal totals', async () => {
		const { root, session } = await fixture();
		const entry = completion(1, 0.03);
		await appendChatEntry(root, session, {
			kind: entry.kind,
			role: entry.role,
			event: entry.event!,
		});
		await deleteSession(root, session.id);
		const dashboard = await buildDashboard(
			root,
			await listSessions(root, true),
			owner,
			new Set(),
		);
		expect(dashboard.rows).toEqual([]);
		expect(dashboard.usage.totalTokens).toBe(15);
		expect(dashboard.deletedSessions).toBe(1);
		const anonymous = await buildDashboard(
			root,
			await listSessions(root, true),
			{ ...owner, accountId: 'bob' },
			new Set(),
		);
		expect(anonymous.usage.totalTokens).toBe(0);
	});

	it('keeps rejected ideas visible and filters without changing totals', async () => {
		const { root, session } = await fixture();
		const rejected = await updateSession(root, session.id, {
			rejectedAt: 1,
			archivedAt: 1,
		});
		const dashboard = await buildDashboard(root, [rejected], owner, new Set());
		expect(dashboard.counts.rejected).toBe(1);
		expect(
			filterWork(dashboard.rows, 'SAL', 'rejected', false, 'pl'),
		).toHaveLength(1);
		expect(filterWork(dashboard.rows, 'missing', '', false, 'pl')).toHaveLength(
			0,
		);
		expect(dashboard.counts.rejected).toBe(1);
	});

	it('formats numbers for the selected locale and exposes partial prices', () => {
		const usage = {
			...emptyUsage(),
			totalTokens: 123456,
			reportedTurns: 2,
			pricedTurns: 1,
			knownCostUsd: 1.25,
			unpricedTurns: 1,
		};
		expect(formatTokens(usage, 'en')).toBe('123,456');
		expect(formatTokens(usage, 'pl')).toBe(
			new Intl.NumberFormat('pl').format(123456),
		);
		expect(formatCost(usage, 'en')).toBe('$1.25 +');
		expect(
			formatCost({ ...usage, pricedTurns: 0, knownCostUsd: 0 }, 'en'),
		).toBe('?');
	});

	it('keeps dashboard translations and status labels available in both locales', async () => {
		const en = JSON.parse(
			await readFile(
				new URL('../src/client/locales/en.json', import.meta.url),
				'utf8',
			),
		) as Record<string, string>;
		const pl = JSON.parse(
			await readFile(
				new URL('../src/client/locales/pl.json', import.meta.url),
				'utf8',
			),
		) as Record<string, string>;
		expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
		for (const key of Object.keys(en).filter((key) =>
			key.startsWith('dashboard.'),
		))
			expect(pl[key]?.length).toBeGreaterThan(0);
	});
});
