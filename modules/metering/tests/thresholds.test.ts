import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MeteringService } from '../src/services/metering-service.ts';
import type { NotificationPublisher } from '../src/services/notifications.ts';
import {
	openMeteringTestDatabase,
	type MeteringTestDatabase,
} from './support/database.ts';
import {
	clock,
	createHarness,
	recordingPublisher,
	RUN_TOKENS_KEY,
} from './support/harness.ts';

const TENANT = 'tenant-thresholds';
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);
const OCTOBER = Date.UTC(2026, 9, 2, 9, 30, 0);
const OWNERS = ['account-ada', 'account-bo'];

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

async function seedLimit(monthlyLimit: number, now: () => number) {
	await createHarness({ repository: shared.repository, now }).service.setLimit({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		monthlyLimit,
		setBy: 'cli:test',
	});
}

async function report(
	service: MeteringService,
	amount: number,
	sourceRef: string,
): Promise<void> {
	await service.record({
		tenantId: TENANT,
		meter: RUN_TOKENS_KEY,
		amount,
		sourceRef,
	});
}

describe('METERING-THRESHOLDS', () => {
	it('publishes one warning and one exhausted notice to the owners, each once', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher,
			owners: OWNERS,
		});

		await report(service, 70, 'run-70');
		expect(publisher.published).toHaveLength(0);

		await report(service, 15, 'run-85');
		await report(service, 5, 'run-90');
		await report(service, 10, 'run-100');
		await report(service, 10, 'run-110');

		expect(
			publisher.published.map((event) => [
				event.kind,
				event.sourceModule,
				event.sourceRef,
				event.recipients,
			]),
		).toEqual([
			[
				'meter-threshold',
				'metering.core',
				`${RUN_TOKENS_KEY}:2026-09:warning`,
				OWNERS,
			],
			[
				'meter-threshold',
				'metering.core',
				`${RUN_TOKENS_KEY}:2026-09:exhausted`,
				OWNERS,
			],
		]);
		expect(publisher.published[0]?.title).toContain('80%');
		expect(publisher.published[1]?.body).toContain('100 of 100');
	});

	/* A month that jumps straight past both points still owes the workspace
	   both statements, and each of them exactly once. */
	it('publishes both notices when one fact passes the warning and the limit together', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher,
			owners: OWNERS,
		});

		await report(service, 500, 'run-500');
		await report(service, 1, 'run-501');

		expect(publisher.published.map((event) => event.sourceRef)).toEqual([
			`${RUN_TOKENS_KEY}:2026-09:warning`,
			`${RUN_TOKENS_KEY}:2026-09:exhausted`,
		]);
	});

	it('notifies again in the next month, and the earlier records stay', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher,
			owners: OWNERS,
		});
		await report(service, 100, 'run-september');
		expect(publisher.published).toHaveLength(2);

		time.set(OCTOBER);
		await report(service, 100, 'run-october');

		expect(publisher.published.map((event) => event.sourceRef)).toEqual([
			`${RUN_TOKENS_KEY}:2026-09:warning`,
			`${RUN_TOKENS_KEY}:2026-09:exhausted`,
			`${RUN_TOKENS_KEY}:2026-10:warning`,
			`${RUN_TOKENS_KEY}:2026-10:exhausted`,
		]);
	});

	it('publishes nothing while the workspace has no limit', async () => {
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: () => SEPTEMBER,
			publisher,
			owners: OWNERS,
		});

		await report(service, 1_000_000, 'run-unlimited');

		expect(publisher.published).toHaveLength(0);
	});

	it('reads the warning share from the setting rather than a copy of it', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const publisher = recordingPublisher();
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher,
			owners: OWNERS,
			warningPercent: () => 50,
		});

		await report(service, 50, 'run-50');

		expect(publisher.published.map((event) => event.sourceRef)).toEqual([
			`${RUN_TOKENS_KEY}:2026-09:warning`,
		]);
	});

	/* notifications.core is optional and a publisher is foreign code: neither an
	   absent module nor a failing one may undo a fact that was counted. */
	it('records the fact when no notifications module is composed', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher: null,
			owners: OWNERS,
		});

		await report(service, 100, 'run-100');

		const buckets = await service.buckets(TENANT, { meter: RUN_TOKENS_KEY });
		expect(buckets.map((bucket) => bucket.amount)).toEqual([100]);
	});

	it('records the fact when the publisher throws', async () => {
		const time = clock(SEPTEMBER);
		await seedLimit(100, time.now);
		const failing: NotificationPublisher = {
			publish: async () => {
				throw new Error('notifications.core is unreachable');
			},
		};
		const { service } = createHarness({
			repository: shared.repository,
			now: time.now,
			publisher: failing,
			owners: OWNERS,
		});

		await report(service, 100, 'run-100');

		const usage = await service.usage(TENANT);
		expect(usage.map((entry) => entry.used)).toEqual([100]);
	});
});
