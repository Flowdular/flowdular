import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import { createHarness, RUN_TOKENS_KEY } from './support/harness.ts';

const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

let shared: MeteringTestDatabase;

beforeAll(async () => {
	shared = await openMeteringTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function seedBothWorkspaces() {
	const { service } = createHarness({
		repository: shared.repository,
		now: () => SEPTEMBER,
	});
	for (const [tenantId, amount, limit] of [
		[ALPHA, 100, 1_000],
		[BETA, 250, 2_000],
	] as const) {
		await service.setLimit({
			tenantId,
			meter: RUN_TOKENS_KEY,
			monthlyLimit: limit,
			setBy: `cli:${tenantId}`,
		});
		await service.record({
			tenantId,
			meter: RUN_TOKENS_KEY,
			amount,
			sourceRef: `run-${tenantId}`,
		});
	}
	return service;
}

describe('METERING-TENANT-BOUNDARY', () => {
	it('shows one workspace only its own meters, buckets and limits', async () => {
		const service = await seedBothWorkspaces();

		expect(
			(await service.usage(ALPHA)).map((entry) => [
				entry.meter.tenantId,
				entry.used,
				entry.limit,
			]),
		).toEqual([[ALPHA, 100, 1_000]]);
		expect(
			(await service.buckets(ALPHA, { meter: RUN_TOKENS_KEY })).map(
				(bucket) => [bucket.tenantId, bucket.amount],
			),
		).toEqual([[ALPHA, 100]]);
		expect(
			(await service.limits(BETA)).map((limit) => [
				limit.tenantId,
				limit.monthlyLimit,
				limit.setBy,
			]),
		).toEqual([[BETA, 2_000, `cli:${BETA}`]]);
		expect(
			(await service.limitEvents(BETA)).map((event) => event.tenantId),
		).toEqual([BETA]);
	});

	it('cannot reach a row of another workspace through a bound transaction', async () => {
		await seedBothWorkspaces();

		for (const table of [
			'metering_meters',
			'metering_buckets',
			'metering_records',
			'metering_limits',
			'metering_limit_events',
		]) {
			const rows = await shared.runtime.transaction(
				(transaction) =>
					transaction.query<{ tenant_id: string }>({
						text: `SELECT tenant_id FROM ${table}`,
					}),
				{ access: 'read', tenantId: ALPHA },
			);
			expect([table, rows.rows.map((row) => row.tenant_id)]).toEqual([
				table,
				[ALPHA],
			]);
		}
	});

	it('rejects a row carrying another tenant identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO metering_buckets
						 (id, tenant_id, meter_key, day, amount, events, updated_at)
						 VALUES ($1, $2, $3, '2026-09-11', 10, 1, $4)`,
						parameters: ['forged', BETA, RUN_TOKENS_KEY, SEPTEMBER],
					}),
				{ access: 'write', tenantId: ALPHA },
			),
		).rejects.toThrow();

		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO metering_limits
						 (id, tenant_id, meter_key, monthly_limit, set_by, updated_at)
						 VALUES ($1, $2, $3, 10, 'forger', $4)`,
						parameters: ['forged-limit', BETA, RUN_TOKENS_KEY, SEPTEMBER],
					}),
				{ access: 'write', tenantId: ALPHA },
			),
		).rejects.toThrow();
	});

	/* One workspace exhausting its limit must not refuse another's operation:
	   the month total is read under the same tenant predicate as the facts. */
	it('checks one workspace against its own usage alone', async () => {
		const { service } = createHarness({
			repository: shared.repository,
			now: () => SEPTEMBER,
		});
		await service.setLimit({
			tenantId: ALPHA,
			meter: RUN_TOKENS_KEY,
			monthlyLimit: 100,
			setBy: 'cli:test',
		});
		await service.setLimit({
			tenantId: BETA,
			meter: RUN_TOKENS_KEY,
			monthlyLimit: 100,
			setBy: 'cli:test',
		});
		await service.record({
			tenantId: ALPHA,
			meter: RUN_TOKENS_KEY,
			amount: 100,
			sourceRef: 'run-alpha',
		});

		expect(
			await service.check({
				tenantId: BETA,
				meter: RUN_TOKENS_KEY,
				amount: 50,
			}),
		).toEqual({ verdict: 'allowed', used: 0, limit: 100 });
	});
});
