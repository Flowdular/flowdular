import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import { OWNER, principal, TENANT } from './support/fakes.ts';
import {
	serviceHarness,
	sinkRegistration,
	SINK_ID,
	sourceRegistration,
	SOURCE_ID,
} from './support/service.ts';

let database: AdaptersTestDatabase;

beforeAll(async () => {
	database = await openAdaptersTestDatabase();
});

beforeEach(async () => {
	await database.reset();
});

afterAll(async () => {
	await database?.dispose();
});

const owner = principal();
const HOUR = 3_600_000;
const NINE = Date.UTC(2026, 8, 16, 9, 0, 0);

async function audit(): Promise<
	readonly { action: string; run_id: string | null; actor_id: string | null }[]
> {
	const result = await database.runtime.transaction(
		(transaction) =>
			transaction.query<{
				action: string;
				run_id: string | null;
				actor_id: string | null;
			}>({
				text: `SELECT action, run_id, actor_id FROM adapter_audit_events
				       ORDER BY occurred_at, id`,
			}),
		{ tenantId: TENANT, access: 'read' },
	);
	return result.rows;
}

describe('ADAPTERS-SCHEDULE a schedule queues a run on its cron', () => {
	it('queues a due run as the account that saved the binding and moves to the next slot, skipping missed ones', async () => {
		const harness = serviceHarness(database, {
			register: (catalogue) =>
				catalogue.sources.register('vendors.core', [
					sourceRegistration({ schedule: '0 * * * *' }),
				]),
		});
		harness.clock = NINE;
		const binding = await harness.service.bind(owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: null,
		});
		expect(binding.nextRunAt).toBe(NINE + HOUR);

		const schedule = harness.schedule();
		await schedule.tick();
		expect((await harness.service.runs(TENANT, { limit: 10 })).items).toEqual(
			[],
		);

		/* The process was away for five hours: one run, then the next slot. */
		harness.clock = NINE + 5 * HOUR + 30_000;
		await schedule.tick();
		const runs = (await harness.service.runs(TENANT, { limit: 10 })).items;
		expect(runs.map((run) => [run.trigger, run.status, run.startedBy])).toEqual(
			[['schedule', 'queued', OWNER]],
		);
		const [overview] = await harness.service.overview(TENANT);
		expect(overview?.binding?.nextRunAt).toBe(NINE + 6 * HOUR);
		expect(await audit()).toEqual([
			{ action: 'binding-saved', run_id: null, actor_id: OWNER },
			{ action: 'binding-enabled', run_id: null, actor_id: OWNER },
			{ action: 'run-started', run_id: runs[0]!.id, actor_id: OWNER },
		]);

		await harness.runs().tick();
		expect(await harness.service.run(TENANT, runs[0]!.id)).toMatchObject({
			status: 'succeeded',
		});
	});

	it('skips a due slot while a run of the adapter is active and records the skip', async () => {
		const harness = serviceHarness(database, {
			register: (catalogue) =>
				catalogue.sinks.register('vendors.core', [
					sinkRegistration({ schedule: '*/15 * * * *' }),
				]),
		});
		harness.clock = NINE;
		await harness.service.bind(owner, {
			adapterId: SINK_ID,
			instanceId: 'instance-crm',
			enabled: true,
			mapping: null,
			schedule: null,
		});
		const manual = await harness.service.start(owner, SINK_ID);
		harness.clock = NINE + 16 * 60_000;
		await harness.schedule().tick();
		const runs = (await harness.service.runs(TENANT, { limit: 10 })).items;
		expect(runs.map((run) => run.id)).toEqual([manual.id]);
		expect((await audit()).map((event) => event.action)).toEqual([
			'binding-saved',
			'binding-enabled',
			'run-started',
			'schedule-skipped',
		]);
		const [overview] = await harness.service.overview(TENANT);
		expect(overview?.binding?.nextRunAt).toBe(NINE + 30 * 60_000);
	});

	it('computes the slot in the workspace zone, and a disabled or on demand binding holds no next time', async () => {
		const harness = serviceHarness(database, {
			timeZone: 'Europe/Warsaw',
			register: (catalogue) =>
				catalogue.sources.register('vendors.core', [
					sourceRegistration({ schedule: '0 9 * * *' }),
				]),
		});
		harness.clock = Date.UTC(2026, 8, 16, 6, 0, 0);
		const warsaw = await harness.service.bind(owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: null,
		});
		expect(warsaw.nextRunAt).toBe(Date.UTC(2026, 8, 16, 7, 0, 0));
		const onDemand = await harness.service.bind(owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: '',
		});
		expect(onDemand.nextRunAt).toBeNull();
		const disabled = await harness.service.bind(owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: false,
			mapping: null,
			schedule: '30 6 * * 1-5',
		});
		expect(disabled.nextRunAt).toBeNull();
		await expect(
			harness.service.bind(owner, {
				adapterId: SOURCE_ID,
				instanceId: null,
				enabled: true,
				mapping: null,
				schedule: 'every day',
			}),
		).rejects.toMatchObject({ code: 'ADAPTER_SCHEDULE_INVALID' });
	});
});
