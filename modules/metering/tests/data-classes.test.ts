import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import {
	BUCKET_RETENTION_DAYS,
	meteringDataClasses,
} from '../src/services/data-classes.ts';
import {
	MAX_SWEEP_BATCH,
	type MeteringService,
} from '../src/services/metering-service.ts';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import { clock, createHarness, RUN_TOKENS_KEY } from './support/harness.ts';

const TENANT = 'tenant-retention';
const DAY_MS = 86_400_000;
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

function declared(service: MeteringService) {
	const registry = createDataClassRegistry();
	registry.declare(
		'metering.core',
		meteringDataClasses(async () => service),
	);
	const entry = registry
		.list()
		.find((module) => module.moduleId === 'metering.core');
	const buckets = entry?.classes.find(
		(declaration) => declaration.key === 'buckets',
	);
	if (!buckets) throw new Error('metering.core declared no bucket class.');
	return buckets;
}

/** Facts on four consecutive days, the oldest first. */
async function seedFourDays(): Promise<MeteringService> {
	const time = clock(SEPTEMBER - 3 * DAY_MS);
	const { service } = createHarness({
		repository: shared.repository,
		now: time.now,
	});
	for (let offset = 0; offset < 4; offset += 1) {
		time.set(SEPTEMBER - (3 - offset) * DAY_MS);
		await service.record({
			tenantId: TENANT,
			meter: RUN_TOKENS_KEY,
			amount: 10,
			sourceRef: `run-${offset}`,
		});
	}
	return service;
}

describe('metering.core.buckets data class', () => {
	it('declares the bucket class with its retention, and nothing else', async () => {
		const { service } = createHarness({ repository: shared.repository });
		const registry = createDataClassRegistry();
		registry.declare(
			'metering.core',
			meteringDataClasses(async () => service),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
					]),
				),
		).toEqual([['metering.core.buckets', BUCKET_RETENTION_DAYS, true]]);
	});

	it('removes the buckets and their claims of days older than the cutoff', async () => {
		const service = await seedFourDays();
		const buckets = declared(service);

		const removed = await buckets.sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - 1 * DAY_MS),
			limit: 100,
		});

		/* Two buckets went, and the claims of those days with them; the count is
		   the rows of the class, so the claims are not counted a second time.
		   The cutoff day itself stays, which is what "strictly older" means. */
		expect(removed).toEqual({ removed: 2 });
		const kept = await service.buckets(TENANT, {
			meter: RUN_TOKENS_KEY,
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(kept.map((bucket) => bucket.day)).toEqual([
			'2026-09-10',
			'2026-09-11',
		]);
		/* The claims of the swept days went with them: a claim that outlived its
		   bucket would suppress a fact whose usage is already gone. The kept
		   day's claim still refuses its repeat. */
		const time = clock(SEPTEMBER);
		const { service: reporter } = createHarness({
			repository: shared.repository,
			now: time.now,
		});
		const fact = { tenantId: TENANT, meter: RUN_TOKENS_KEY, amount: 1 };
		expect(
			(await reporter.record({ ...fact, sourceRef: 'run-0' })).recorded,
		).toBe(true);
		expect(
			(await reporter.record({ ...fact, sourceRef: 'run-3' })).recorded,
		).toBe(false);
	});

	/* The class contract is "at most `limit` rows", and the registry paces the
	   sweep by what comes back: counting the claims as well overstates the pass
	   and can report twice the batch it was given. */
	it('removes no more than the limit it was given', async () => {
		const service = await seedFourDays();
		const buckets = declared(service);

		const removed = await buckets.sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 1,
		});

		expect(removed.removed).toBe(1);
		const kept = await service.buckets(TENANT, {
			meter: RUN_TOKENS_KEY,
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(kept).toHaveLength(3);
	});

	/* METERING-SWEEP-BATCH. The registry paces the pass and owns the batch it
	   asks with; refusing a batch this module would not have chosen leaves the
	   workspace's expired rows in place for good. */
	it('METERING-SWEEP-BATCH sweeps under a batch that is not a whole number', async () => {
		const service = await seedFourDays();
		const buckets = declared(service);

		const removed = await buckets.sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 1.5,
		});

		expect(removed.removed).toBe(1);
	});

	it('METERING-SWEEP-BATCH caps a batch over its own ceiling', async () => {
		const service = await seedFourDays();
		const buckets = declared(service);

		const removed = await buckets.sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: MAX_SWEEP_BATCH + 1,
		});

		expect(removed.removed).toBe(4);
		expect(
			await service.buckets(TENANT, { meter: RUN_TOKENS_KEY }),
		).toHaveLength(0);
	});

	it('sweeps one workspace without touching another', async () => {
		const service = await seedFourDays();
		const other = createHarness({
			repository: shared.repository,
			now: () => SEPTEMBER - 3 * DAY_MS,
		}).service;
		await other.record({
			tenantId: 'tenant-other',
			meter: RUN_TOKENS_KEY,
			amount: 5,
			sourceRef: 'run-other',
		});

		await declared(service).sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 100,
		});

		expect(
			await service.buckets(TENANT, { meter: RUN_TOKENS_KEY }),
		).toHaveLength(0);
		expect(
			(
				await other.buckets('tenant-other', {
					meter: RUN_TOKENS_KEY,
					from: '2026-09-01',
					to: '2026-09-30',
				})
			).map((bucket) => bucket.amount),
		).toEqual([5]);
	});

	it('exports every bucket of one workspace with its oldest and newest day', async () => {
		const service = await seedFourDays();
		const rows: Record<string, unknown>[] = [];

		const summary = await declared(service).export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(4);
		expect(summary.from?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
		expect(summary.to?.toISOString()).toBe('2026-09-11T00:00:00.000Z');
		expect(rows.map((row) => row['day']).sort()).toEqual([
			'2026-09-08',
			'2026-09-09',
			'2026-09-10',
			'2026-09-11',
		]);
	});

	it('walks the export in pages rather than one query', async () => {
		const service = await seedFourDays();
		const rows: Record<string, unknown>[] = [];

		const summary = await service.exportBuckets(
			TENANT,
			{
				write: async (row) => {
					rows.push(row);
				},
			},
			2,
		);

		expect(summary.rows).toBe(4);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('exports nothing and reports no range for a workspace without buckets', async () => {
		const { service } = createHarness({ repository: shared.repository });

		const summary = await declared(service).export!({
			tenantId: 'tenant-empty',
			sink: { write: async () => undefined },
		});

		expect(summary).toEqual({ rows: 0, from: null, to: null });
	});
});
