import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { METERING_METERS_CAPABILITY } from '../src/domain/meters.ts';
import { MeteringServiceError } from '../src/services/service-error.ts';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import {
	clock,
	createHarness,
	REPORTER,
	RUN_TOKENS,
	RUN_TOKENS_KEY,
} from './support/harness.ts';

const TENANT = 'tenant-metering';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);
const OCTOBER = Date.UTC(2026, 9, 1, 0, 30, 0);

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

function harness(now: () => number) {
	return createHarness({ repository: shared.repository, now });
}

async function setLimit(monthlyLimit: number, now: () => number) {
	await harness(now).service.setLimit({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		monthlyLimit,
		setBy: 'cli:test',
	});
}

describe('METERING-DECLARE-RECORD', () => {
	it('sums two facts of one UTC day into one bucket with two events', async () => {
		const { service } = harness(() => SEPTEMBER);

		expect(
			await service.record({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 400,
				sourceRef: 'run-1',
			}),
		).toEqual({ recorded: true, day: '2026-09-11' });
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 600,
			sourceRef: 'run-2',
		});

		const buckets = await service.buckets(TENANT, { meter: RUN_TOKENS_KEY });
		expect(
			buckets.map((bucket) => [bucket.day, bucket.amount, bucket.events]),
		).toEqual([['2026-09-11', 1_000, 2]]);
	});

	it('changes nothing when a source reference is reported again', async () => {
		const { service } = harness(() => SEPTEMBER);
		const fact = {
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 400,
			sourceRef: 'run-1',
		};
		await service.record(fact);

		expect(await service.record(fact)).toEqual({
			recorded: false,
			day: '2026-09-11',
		});

		const buckets = await service.buckets(TENANT, { meter: RUN_TOKENS_KEY });
		expect(buckets.map((bucket) => [bucket.amount, bucket.events])).toEqual([
			[400, 1],
		]);
	});

	/* Without a source reference the reporter is asking for every call to count;
	   the day bucket is the only place the facts are kept. */
	it('counts every fact that names no source reference', async () => {
		const { service } = harness(() => SEPTEMBER);
		for (const amount of [10, 10, 10]) {
			await service.record({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount,
			});
		}

		const buckets = await service.buckets(TENANT, { meter: RUN_TOKENS_KEY });
		expect(buckets.map((bucket) => [bucket.amount, bucket.events])).toEqual([
			[30, 3],
		]);
	});

	it('shows the meter with its module, label and unit once a fact landed', async () => {
		const { service } = harness(() => SEPTEMBER);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 400,
			sourceRef: 'run-1',
		});

		const usage = await service.usage(TENANT);
		expect(
			usage.map((entry) => [
				entry.meter.key,
				entry.meter.moduleId,
				entry.meter.label,
				entry.meter.unit,
				entry.meter.kind,
				entry.month,
				entry.used,
				entry.limit,
			]),
		).toEqual([
			[
				RUN_TOKENS_KEY,
				REPORTER,
				RUN_TOKENS.label,
				RUN_TOKENS.unit,
				RUN_TOKENS.kind,
				'2026-09',
				400,
				null,
			],
		]);
	});

	it('refuses a meter no composed module declared', async () => {
		const { service } = harness(() => SEPTEMBER);

		await expect(
			service.record({
				tenantId: TENANT,
				meter: 'billing.core.invoices',
				amount: 1,
			}),
		).rejects.toMatchObject({ code: 'METER_NOT_DECLARED' });
	});

	it('refuses an amount that is not a whole non-negative number', async () => {
		const { service } = harness(() => SEPTEMBER);

		for (const amount of [-1, 1.5, Number.NaN]) {
			await expect(
				service.record({
					tenantId: TENANT,
					meter: RUN_TOKENS_KEY,
					amount,
				}),
			).rejects.toBeInstanceOf(MeteringServiceError);
		}
	});

	/* An instant a Date cannot represent, and one at the top of the range that
	   formats as an expanded year: both would otherwise reach the day column,
	   the first as a thrown RangeError that loses the fact, the second as the
	   ten characters "+275760-0", which is not a day at all. */
	it('refuses an instant no UTC day covers, and counts nothing', async () => {
		const { service } = harness(() => SEPTEMBER);

		for (const at of [Number.MAX_SAFE_INTEGER, 8.64e15, 8.64e15 + 1]) {
			await expect(
				service.record({
					tenantId: TENANT,
					meter: RUN_TOKENS_KEY,
					amount: 1,
					at,
				}),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}

		expect(await service.buckets(TENANT, { meter: RUN_TOKENS_KEY })).toEqual(
			[],
		);
	});

	/* A month sum past the safe integer range is read inside the transaction
	   that counts the fact. Refusing it there would roll the counted fact back,
	   and a reporter without a source reference would retry it into a second
	   count; any ceiling is smaller, so the over-approximation is still over
	   every limit. */
	it('counts a fact whose month sum is past the safe integer range', async () => {
		const now = () => SEPTEMBER;
		await setLimit(1_000, now);
		const { service } = harness(now);
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO metering_buckets
					 (id, tenant_id, meter_key, day, amount, events, updated_at)
					 VALUES ($1, $2, $3, '2026-09-01', 9223372036854775807, 1, $4)`,
					parameters: ['bucket-huge', TENANT, RUN_TOKENS_KEY, SEPTEMBER],
				}),
			{ access: 'write', tenantId: TENANT },
		);

		expect(
			await service.record({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 5,
				sourceRef: 'run-after-overflow',
			}),
		).toEqual({ recorded: true, day: '2026-09-11' });

		/* The seeded day is read past on purpose: a single bucket amount out of
		   range is a read that fails loudly and loses nothing, while the month
		   sum is read where a failure would undo a counted fact. */
		expect(
			(
				await service.buckets(TENANT, {
					meter: RUN_TOKENS_KEY,
					from: '2026-09-11',
					to: '2026-09-11',
				})
			).map((bucket) => [bucket.day, bucket.amount]),
		).toEqual([['2026-09-11', 5]]);
		expect(
			(
				await service.check({
					tenantId: TENANT,
					meter: RUN_TOKENS_KEY,
					amount: 1,
				})
			).verdict,
		).toBe('refused');
	});

	it('names the capability the way a reporting module resolves it', () => {
		expect(METERING_METERS_CAPABILITY).toBe('metering.meters.v1');
	});
});

describe('METERING-CHECK', () => {
	it('allows an amount inside the limit and refuses the one that passes it', async () => {
		const now = () => SEPTEMBER;
		await setLimit(100, now);
		const { service } = harness(now);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 90,
			sourceRef: 'run-90',
		});

		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 5,
			}),
		).toEqual({ verdict: 'allowed', used: 90, limit: 100 });
		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 20,
			}),
		).toEqual({ verdict: 'refused', used: 90, limit: 100 });

		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 10,
			sourceRef: 'run-100',
		});
		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 1,
			}),
		).toEqual({ verdict: 'refused', used: 100, limit: 100 });
	});

	/* The limit is a ceiling the month may reach, not one it must stay under:
	   the amount that lands exactly on it is allowed and the next one is not. */
	it('allows the amount that reaches the limit exactly and refuses the next', async () => {
		const now = () => SEPTEMBER;
		await setLimit(100, now);
		const { service } = harness(now);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 95,
			sourceRef: 'run-95',
		});

		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 5,
			}),
		).toEqual({ verdict: 'allowed', used: 95, limit: 100 });
		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 6,
			}),
		).toEqual({ verdict: 'refused', used: 95, limit: 100 });
	});

	it('warns on the amount that carries the month past the warning share', async () => {
		const now = () => SEPTEMBER;
		await setLimit(100, now);
		const { service } = harness(now);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 70,
			sourceRef: 'run-70',
		});

		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 10,
			}),
		).toEqual({ verdict: 'warning', used: 70, limit: 100 });
		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 5,
			}),
		).toEqual({ verdict: 'allowed', used: 70, limit: 100 });
	});

	it('always allows a workspace without a limit', async () => {
		const { service } = harness(() => SEPTEMBER);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 1_000_000,
			sourceRef: 'run-big',
		});

		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 1_000_000,
			}),
		).toEqual({ verdict: 'allowed', used: 1_000_000, limit: null });
	});

	it('writes nothing, so the caller decides what to do with a refusal', async () => {
		const now = () => SEPTEMBER;
		await setLimit(100, now);
		const { service } = harness(now);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 90,
			sourceRef: 'run-90',
		});

		await service.check({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 20,
		});

		const buckets = await service.buckets(TENANT, { meter: RUN_TOKENS_KEY });
		expect(buckets.map((bucket) => bucket.amount)).toEqual([90]);
	});
});

describe('METERING-MONTH-RESET', () => {
	it('allows again in the next calendar month and keeps the earlier buckets', async () => {
		const time = clock(SEPTEMBER);
		await setLimit(100, time.now);
		const { service } = harness(time.now);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 100,
			sourceRef: 'run-exhausting',
		});
		expect(
			(
				await service.check({
					tenantId: TENANT,
					meter: RUN_TOKENS_KEY,
					amount: 1,
				})
			).verdict,
		).toBe('refused');

		time.set(OCTOBER);

		expect(
			await service.check({
				tenantId: TENANT,
				meter: RUN_TOKENS_KEY,
				amount: 1,
			}),
		).toEqual({ verdict: 'allowed', used: 0, limit: 100 });
		const kept = await service.buckets(TENANT, {
			meter: RUN_TOKENS_KEY,
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(kept.map((bucket) => [bucket.day, bucket.amount])).toEqual([
			['2026-09-11', 100],
		]);
		const usage = await service.usage(TENANT);
		expect(usage.map((entry) => [entry.month, entry.used])).toEqual([
			['2026-10', 0],
		]);
	});
});
