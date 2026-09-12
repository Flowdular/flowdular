import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createTracer } from '@flowdular/server';
import { createAuthRuntime } from '../src/server/runtime.ts';
import { EXPIRED_SESSION_SWEEP_BATCH } from '../src/services/database-repository.ts';
import {
	createSessionSweepRunner,
	SESSION_SWEEP_JOB,
} from '../src/services/session-sweep-runner.ts';
import {
	closeAuthTestDatabases,
	testRuntime,
	type TestRuntime,
} from './helpers.ts';

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 8, 12, 9, 0, 0);
const TENANT = 'sweep-tenant';
const ACCOUNT = 'sweep-account';

/** Three batches: two the bound fills and a short one that ends the pass. */
const BACKLOG = 2 * EXPIRED_SESSION_SWEEP_BATCH + 500;

const IDLE_PASS = { claimed: 0, performed: 0, failed: 0, claimLost: 0 };
const ONE_SWEEP = { claimed: 1, performed: 1, failed: 0, claimLost: 0 };

let auth: TestRuntime | undefined;

afterEach(async () => {
	await auth?.dispose();
	auth = undefined;
});
afterAll(closeAuthTestDatabases);

async function workspace(): Promise<TestRuntime> {
	const runtime = await testRuntime();
	auth = runtime;
	runtime.clock.now = NOW;
	await runtime.repository.createAccountWithTenant({
		accountId: ACCOUNT,
		tenantId: TENANT,
		email: 'owner@example.test',
		normalizedEmail: 'owner@example.test',
		passwordHash: 'fixture-hash',
		displayName: 'Owner',
		organizationName: 'Sweep',
		organizationSlug: 'sweep',
		role: 'owner',
		scopes: ['auth.profile.read'],
		createdAt: NOW - 24 * HOUR_MS,
	});
	return runtime;
}

/* The rows go in with one statement because a case needs thousands of them and
   what it asserts is the sweep, not the writer. */
async function seedSessions(
	runtime: TestRuntime,
	label: string,
	count: number,
	expiresAt: number,
): Promise<void> {
	await runtime.database.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: `INSERT INTO auth_sessions
				       (id, token_hash, account_id, tenant_id, csrf_token,
				        created_at, expires_at, last_seen_at)
				       SELECT $1::text || n, $1::text || '-hash-' || n, $2::text,
				              $3::text, $1::text || '-csrf-' || n,
				              $4::bigint, $5::bigint, $4::bigint
				       FROM generate_series(1, $6::int) AS n`,
				parameters: [
					label,
					ACCOUNT,
					TENANT,
					NOW - 24 * HOUR_MS,
					expiresAt,
					count,
				],
			}),
		{ tenantId: TENANT, access: 'write' },
	);
}

async function sessionCount(runtime: TestRuntime): Promise<number> {
	const rows = await runtime.database.runtime.transaction(
		async (transaction) =>
			(
				await transaction.query<{ count: number | bigint | string }>({
					text: 'SELECT count(*) AS count FROM auth_sessions',
				})
			).rows,
		{ tenantId: TENANT, access: 'read' },
	);
	return Number(rows[0]?.count ?? 0);
}

describe('the expired session sweep', () => {
	it('removes a backlog in bounded batches and leaves live sessions alone', async () => {
		const runtime = await workspace();
		await seedSessions(runtime, 'expired', BACKLOG, NOW - 1);
		await seedSessions(runtime, 'live', 2, NOW + HOUR_MS);

		/* Two batches remove two batches worth of rows and not one row more,
		   however large the backlog behind them is. */
		expect(await runtime.repository.deleteExpiredSessions(NOW, 2)).toBe(
			2 * EXPIRED_SESSION_SWEEP_BATCH,
		);
		expect(await sessionCount(runtime)).toBe(502);

		/* The third batch comes back short, so the pass stops there: the backlog
		   is drained and both live sessions are still there. */
		expect(await runtime.repository.deleteExpiredSessions(NOW)).toBe(500);
		expect(await sessionCount(runtime)).toBe(2);
	});

	it('sweeps once per runner pass and claims exactly once', async () => {
		const runtime = await workspace();
		await seedSessions(runtime, 'expired', 3, NOW - 1);
		await seedSessions(runtime, 'live', 1, NOW + HOUR_MS);
		const sweep = createSessionSweepRunner({
			sweep: () => Promise.resolve(runtime.authService),
			intervalMs: 60_000,
		});

		try {
			expect(await sweep.tick()).toEqual(ONE_SWEEP);
			expect(await sessionCount(runtime)).toBe(1);
			/* A pass over a table with nothing expired still claims once and still
			   performs the sweep; it removes nothing. */
			expect(await sweep.tick()).toEqual(ONE_SWEEP);
			expect(await sessionCount(runtime)).toBe(1);
		} finally {
			await sweep.dispose();
		}
	});

	it('drains the sweep in flight before disposal answers', async () => {
		let release = (): void => undefined;
		let entered = (): void => undefined;
		const inSweep = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let swept = false;
		const sweep = createSessionSweepRunner({
			intervalMs: 60_000,
			sweep: () =>
				Promise.resolve({
					deleteExpiredSessions: async () => {
						entered();
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						swept = true;
						return 0;
					},
				}),
		});

		void sweep.tick();
		await inSweep;
		let settled = false;
		const disposal = sweep.dispose().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		/* The delete is still running, so disposal is still waiting on it. */
		expect([swept, settled]).toEqual([false, false]);

		release();
		await disposal;
		expect([swept, settled]).toEqual([true, true]);
		/* Disposal is terminal: a later pass claims nothing and performs nothing. */
		expect(await sweep.tick()).toEqual(IDLE_PASS);
	});

	it('records the pass as a root span with the swept item under it', async () => {
		const tracer = createTracer();
		const sweep = createSessionSweepRunner({
			intervalMs: 60_000,
			sweep: () =>
				Promise.resolve({ deleteExpiredSessions: () => Promise.resolve(0) }),
			tracer,
		});

		try {
			await sweep.tick();
		} finally {
			await sweep.dispose();
		}

		const spans = tracer.drain();
		const pass = spans.find((span) => span.name === `job ${SESSION_SWEEP_JOB}`);
		const item = spans.find(
			(span) => span.name === `job ${SESSION_SWEEP_JOB} item`,
		);
		/* A pass belongs to the loop, not to whatever enqueued the work, so it is
		   a root and the item it performed hangs under it. */
		expect([pass?.parentSpanId, pass?.status]).toEqual([null, 'ok']);
		expect(pass?.attributes['flowdular.job.performed']).toBe(1);
		expect([item?.parentSpanId, item?.traceId]).toEqual([
			pass?.spanId,
			pass?.traceId,
		]);
	});

	it('starts with the service the runtime opens and stops when it is disposed', async () => {
		const fixture = await workspace();
		await seedSessions(fixture, 'expired', 3, Date.now() - 60_000);
		const runtime = createAuthRuntime({
			databases: fixture.database.provider,
			secureCookies: false,
			sessionTtlMs: HOUR_MS,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
		});

		try {
			/* Nothing has asked for the service, so no sweep has opened a database. */
			expect(await sessionCount(fixture)).toBe(3);
			await runtime.service();
			await vi.waitFor(
				async () => expect(await sessionCount(fixture)).toBe(0),
				{ timeout: 5_000, interval: 25 },
			);
		} finally {
			await runtime.dispose();
		}
	});
});
