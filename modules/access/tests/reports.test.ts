import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessChange } from '../src/domain/types.ts';
import { openHarness, PASSWORD, type Harness } from './support/harness.ts';

let harness: Harness;
let seed: Awaited<ReturnType<typeof seeded>>;

beforeAll(async () => {
	harness = await openHarness();
	seed = await seeded();
});

afterAll(async () => {
	await harness?.dispose();
});

interface ReportBody {
	readonly items: readonly AccessChange[];
	readonly page: { readonly nextCursor: string | null };
	readonly window: { readonly from: number; readonly to: number };
	readonly source: string;
}

function isoDay(offsetDays: number): string {
	return new Date(Date.now() + offsetDays * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

async function report(
	kind: 'diff' | 'activity',
	session: Parameters<Harness['owner']>[0],
	query: string,
): Promise<{ status: number; body: ReportBody }> {
	const response = await harness.call(`/api/access/${kind}?${query}`, {
		session,
	});
	return {
		status: response.status,
		body: (await response.json()) as ReportBody,
	};
}

/**
 * One workspace with a membership change, a role change, an administrative
 * password reset and an ordinary sign-in, so the two reports have something to
 * agree and something to disagree about.
 */
async function seeded() {
	const workspace = await harness.signUp('owner@example.com', 'reports-one');
	const owner = await harness.owner(workspace);
	const service = await harness.service();
	const member = await service.createTenantMember(
		{
			tenantId: workspace.tenantId,
			email: 'member@example.com',
			password: PASSWORD,
			displayName: 'Member Person',
			role: 'member',
		},
		owner,
	);
	await service.assignMemberRole(owner, member.accountId, 'owner');
	await service.resetMemberPassword(owner, member.accountId, PASSWORD);
	await harness.signIn('member@example.com', 'reports-one');
	return { workspace, member };
}

describe('ACCESS-DIFF the diff answers what changed between two dates', () => {
	it('names the role change inside the window and nothing outside it', async () => {
		const { workspace, member } = seed;
		const inside = `from=${isoDay(-1)}&to=${isoDay(1)}`;

		const current = await report('diff', workspace, inside);
		const past = await report(
			'diff',
			workspace,
			'from=2020-01-01&to=2020-01-02',
		);

		expect(current.status).toBe(200);
		expect(current.body.source).toBe('auth.core');
		const roleChange = current.body.items.find(
			(item) => item.action === 'users.member.role',
		);
		expect(roleChange).toMatchObject({
			category: 'role',
			actor: 'owner@example.com',
			subjectType: 'account',
			subjectId: member.accountId,
			detail: 'role=owner',
		});
		expect(
			current.body.items.every(
				(item) => item.occurredAt >= current.body.window.from,
			),
		).toBe(true);
		expect(past.body.items).toEqual([]);
		expect(past.body.page.nextCursor).toBeNull();
	});

	it('leaves out what grants nobody anything, which the activity report keeps', async () => {
		const { workspace } = seed;
		const window = `from=${isoDay(-1)}&to=${isoDay(1)}`;

		const diff = await report('diff', workspace, window);
		const activity = await report('activity', workspace, window);

		const actions = (body: ReportBody) => body.items.map((item) => item.action);
		expect(actions(diff.body)).toContain('users.member.role');
		expect(actions(diff.body)).not.toContain('users.member.password-reset');
		expect(actions(activity.body)).toContain('users.member.role');
		expect(actions(activity.body)).toContain('users.member.password-reset');
	});

	it('pages a window without repeating or skipping a change', async () => {
		const { workspace } = seed;
		const window = `from=${isoDay(-1)}&to=${isoDay(1)}&limit=1`;

		const first = await report('diff', workspace, window);
		const second = await report(
			'diff',
			workspace,
			`${window}&cursor=${encodeURIComponent(first.body.page.nextCursor!)}`,
		);
		const third = await report(
			'diff',
			workspace,
			`${window}&cursor=${encodeURIComponent(second.body.page.nextCursor!)}`,
		);

		expect(first.body.items).toHaveLength(1);
		expect(second.body.items).toHaveLength(1);
		expect(first.body.items[0]!.id).not.toBe(second.body.items[0]!.id);
		expect(
			[first, second].flatMap((page) =>
				page.body.items.map((item) => item.action),
			),
		).toEqual(['users.member.role', 'users.member.created']);
		expect(third.body.items).toEqual([]);
		expect(third.body.page.nextCursor).toBeNull();
	});
});

describe('ACCESS-ACTIVITY the activity report is filtered to privileged actions', () => {
	it('leaves out the ordinary sign-in activity of the same window', async () => {
		const { workspace } = seed;

		const activity = await report(
			'activity',
			workspace,
			`from=${isoDay(-1)}&to=${isoDay(1)}`,
		);

		expect(activity.body.items.length).toBeGreaterThan(0);
		expect(activity.body.items.map((item) => item.action)).not.toContain(
			'auth.sign-in.succeeded',
		);
		expect(activity.body.items.map((item) => item.action)).not.toContain(
			'auth.sign-out',
		);
	});

	it('answers newest first', async () => {
		const { workspace } = seed;

		const activity = await report(
			'activity',
			workspace,
			`from=${isoDay(-1)}&to=${isoDay(1)}`,
		);

		const times = activity.body.items.map((item) => item.occurredAt);
		expect([...times].sort((left, right) => right - left)).toEqual(times);
	});
});

describe('ACCESS-RANGE-BOUNDS a report refuses a range before it reads anything', () => {
	it('refuses a missing, malformed, reversed or oversized range', async () => {
		const workspace = await harness.signUp('bounds@example.com', 'reports-two');
		const codes: string[] = [];
		for (const query of [
			'from=2026-01-01',
			'from=yesterday&to=2026-01-02',
			'from=2026-02-30&to=2026-03-01',
			'from=2026-03-01&to=2026-02-01',
			'from=2020-01-01&to=2026-01-01',
		]) {
			const response = await harness.call(`/api/access/activity?${query}`, {
				session: workspace,
			});
			const body = (await response.json()) as {
				error: { code: string };
			};
			codes.push(`${response.status} ${body.error.code}`);
		}

		expect(codes).toEqual([
			'400 INVALID_INPUT',
			'400 INVALID_INPUT',
			'400 INVALID_INPUT',
			'400 RANGE_REVERSED',
			'400 RANGE_TOO_LONG',
		]);
	});

	it('refuses a cursor this server did not sign', async () => {
		const workspace = await harness.signUp(
			'cursor@example.com',
			'reports-three',
		);

		const response = await harness.call(
			`/api/access/diff?from=${isoDay(-1)}&to=${isoDay(1)}&cursor=c1.forged.signature`,
			{ session: workspace },
		);

		expect(response.status).toBe(400);
		expect(
			(await response.json()) as { error: { code: string } },
		).toMatchObject({ error: { code: 'CURSOR_INVALID' } });
	});
});
