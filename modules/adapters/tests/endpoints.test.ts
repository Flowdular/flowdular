import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTERS_PERMISSIONS } from '../src/acl/permissions.ts';
import { endpoints } from '../src/api/endpoints.ts';
import {
	openHttpHarness,
	type HttpHarness,
	type Workspace,
} from './support/http.ts';
import { SINK_ID, SOURCE_ID } from './support/service.ts';

let harness: HttpHarness;
let owner: Workspace;
const SLUG = 'adapters-endpoints';

beforeAll(async () => {
	harness = await openHttpHarness();
	owner = await harness.signUp('owner@example.com', SLUG);
});

afterAll(async () => {
	await harness?.dispose();
});

interface Page<T> {
	readonly items: readonly T[];
	readonly page: { readonly nextCursor: string | null };
}

const post = (
	path: string,
	session: Workspace | undefined,
	body: unknown,
	csrfToken: string | null | undefined = session?.csrfToken,
) =>
	harness.call(path, {
		method: 'POST',
		session,
		body,
		...(csrfToken === null || csrfToken === undefined ? {} : { csrfToken }),
	});

const MUTATIONS: readonly [string, unknown][] = [
	[
		'/api/adapters/bind',
		{
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: null,
		},
	],
	['/api/adapters/dry-run', { adapterId: SOURCE_ID }],
	['/api/adapters/runs/start', { adapterId: SOURCE_ID }],
	['/api/adapters/runs/resume', { runId: 'run-x' }],
	['/api/adapters/runs/cancel', { runId: 'run-x' }],
];

describe('adapters.core endpoints', () => {
	it('declares every endpoint it serves', () => {
		expect([...endpoints]).toEqual([
			'adapters.list',
			'adapters.runs.list',
			'adapters.runs.get',
			'adapters.runs.rows',
			'adapters.bind',
			'adapters.dry-run',
			'adapters.runs.start',
			'adapters.runs.resume',
			'adapters.runs.cancel',
		]);
	});

	it('ADAPTERS-DENY answers 401 without a session and 403 without the permission before anything is read or written', async () => {
		const reads = [
			'/api/adapters',
			'/api/adapters/runs',
			'/api/adapters/runs/x',
			'/api/adapters/runs/x/rows',
		];
		for (const path of reads) {
			expect([path, (await harness.call(path)).status]).toEqual([path, 401]);
		}
		for (const [path, body] of MUTATIONS) {
			expect([path, (await post(path, undefined, body)).status]).toEqual([
				path,
				401,
			]);
		}
		const plain = await harness.member(owner, SLUG, 'plain@example.com', []);
		for (const path of reads) {
			expect([
				path,
				(await harness.call(path, { session: plain })).status,
			]).toEqual([path, 403]);
		}
		const reader = await harness.member(owner, SLUG, 'reader@example.com', [
			ADAPTERS_PERMISSIONS.read,
		]);
		expect(
			(await harness.call('/api/adapters', { session: reader })).status,
		).toBe(200);
		for (const [path, body] of MUTATIONS) {
			expect([path, (await post(path, reader, body)).status]).toEqual([
				path,
				403,
			]);
		}
		expect(harness.writer.writes).toEqual([]);
		const runs = (await (
			await harness.call('/api/adapters/runs', { session: owner })
		).json()) as Page<unknown>;
		expect(runs.items).toEqual([]);
	});

	it('ADAPTERS-CSRF refuses every mutation without the session proof and writes nothing', async () => {
		for (const [path, body] of MUTATIONS) {
			const response = await post(path, owner, body, null);
			expect([path, response.status]).toEqual([path, 403]);
		}
		const adapters = (await (
			await harness.call('/api/adapters', { session: owner })
		).json()) as { adapters: { id: string; binding: unknown }[] };
		expect(
			adapters.adapters.map((adapter) => [adapter.id, adapter.binding]),
		).toEqual([
			[SINK_ID, null],
			[SOURCE_ID, null],
		]);
	});

	it('binds, previews, runs and pages the runs and their rows for an owner', async () => {
		const refused = await post('/api/adapters/bind', owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: [{ from: 'id', to: 'reference', transform: 'rename' }],
			schedule: null,
		});
		expect(refused.status).toBe(400);
		expect(
			((await refused.json()) as { error: { code: string } }).error.code,
		).toBe('MAPPING_INVALID');

		const bound = await post('/api/adapters/bind', owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: '0 6 * * *',
		});
		expect(bound.status).toBe(200);
		const binding = (
			(await bound.json()) as { binding: Record<string, unknown> }
		).binding;
		expect(binding).toMatchObject({
			adapterId: SOURCE_ID,
			enabled: true,
			schedule: '0 6 * * *',
			updatedBy: owner.accountId,
		});
		expect(binding).not.toHaveProperty('tenantId');

		const preview = await post('/api/adapters/dry-run', owner, {
			adapterId: SOURCE_ID,
		});
		expect(preview.status).toBe(200);
		expect(
			((await preview.json()) as { dryRun: { rows: unknown[] } }).dryRun.rows,
		).toHaveLength(2);

		const started = await post('/api/adapters/runs/start', owner, {
			adapterId: SOURCE_ID,
		});
		expect(started.status).toBe(201);
		const run = ((await started.json()) as { run: Record<string, unknown> })
			.run;
		expect(run).not.toHaveProperty('claimedBy');
		const again = await post('/api/adapters/runs/start', owner, {
			adapterId: SOURCE_ID,
		});
		expect(again.status).toBe(409);

		await harness.adapters.tickRuns();
		const detail = (await (
			await harness.call(`/api/adapters/runs/${run.id}`, { session: owner })
		).json()) as { run: { status: string; rowsRead: number } };
		expect(detail.run).toMatchObject({ status: 'succeeded', rowsRead: 3 });

		const firstRows = (await (
			await harness.call(`/api/adapters/runs/${run.id}/rows?limit=2`, {
				session: owner,
			})
		).json()) as Page<{ rowIndex: number }>;
		expect(firstRows.items.map((row) => row.rowIndex)).toEqual([1, 2]);
		expect(firstRows.page.nextCursor).not.toBeNull();
		const lastRows = (await (
			await harness.call(
				`/api/adapters/runs/${run.id}/rows?limit=2&cursor=${firstRows.page.nextCursor}`,
				{ session: owner },
			)
		).json()) as Page<{ rowIndex: number }>;
		expect(lastRows.items.map((row) => row.rowIndex)).toEqual([3]);
		expect(lastRows.page.nextCursor).toBeNull();

		const tampered = await harness.call(
			`/api/adapters/runs?cursor=${firstRows.page.nextCursor}`,
			{ session: owner },
		);
		expect(tampered.status).toBe(400);

		const listed = (await (
			await harness.call(`/api/adapters/runs?adapterId=${SOURCE_ID}`, {
				session: owner,
			})
		).json()) as Page<{ id: string }>;
		expect(listed.items.map((entry) => entry.id)).toEqual([run.id]);

		const cancel = await post('/api/adapters/runs/cancel', owner, {
			runId: run.id,
		});
		expect(cancel.status).toBe(409);
		const missing = await post('/api/adapters/runs/resume', owner, {
			runId: 'run-missing',
		});
		expect(missing.status).toBe(404);

		const overview = (await (
			await harness.call('/api/adapters', { session: owner })
		).json()) as {
			adapters: {
				id: string;
				recorded: boolean;
				target: { kind: string; available: boolean };
				lastRun: Record<string, unknown> | null;
			}[];
		};
		const source = overview.adapters.find(
			(adapter) => adapter.id === SOURCE_ID,
		)!;
		expect(source).toMatchObject({
			recorded: true,
			target: { kind: 'port', available: true },
			lastRun: { id: run.id, status: 'succeeded' },
		});
		expect(source.lastRun).not.toHaveProperty('leaseUntil');
	});

	it('bounds the body of a binding', async () => {
		const response = await post('/api/adapters/bind', owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: false,
			mapping: Array.from({ length: 400 }, (_, index) => ({
				from: 'x'.repeat(150),
				to: `field${index}`,
				transform: 'rename',
			})),
			schedule: null,
		});
		expect(response.status).toBe(413);
	});
});
