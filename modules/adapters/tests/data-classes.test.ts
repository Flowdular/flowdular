import type { DataClassExportSink } from '@flowdular/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adaptersDataClasses } from '../src/services/data-classes.ts';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import { OWNER, principal, TENANT } from './support/fakes.ts';
import { serviceHarness, SOURCE_ID } from './support/service.ts';

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

const DAY = 86_400_000;

function sink(): DataClassExportSink & {
	readonly rows: Record<string, unknown>[];
} {
	const rows: Record<string, unknown>[] = [];
	return {
		rows,
		write: async (row: Record<string, unknown>) => {
			rows.push(row);
		},
	} as never;
}

describe('ADAPTERS-RETENTION the adapters data classes', () => {
	it('sweeps runs and rows past their cutoff, exports every class and erases the account from runs, bindings and events', async () => {
		const harness = serviceHarness(database);
		const classes = new Map(
			adaptersDataClasses(async () => database.repository).map((entry) => [
				entry.key,
				entry,
			]),
		);
		expect([...classes.keys()]).toEqual([
			'run-rows',
			'runs',
			'bindings',
			'audit',
		]);
		expect(
			[...classes.values()].map((entry) => [
				entry.key,
				entry.defaultRetentionDays,
			]),
		).toEqual([
			['run-rows', 30],
			['runs', 90],
			['bindings', null],
			['audit', null],
		]);

		const owner = principal();
		await harness.service.bind(owner, {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: null,
		});
		const old = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		harness.clock += 100 * DAY;
		const recent = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();

		const rowsSweep = await classes.get('run-rows')!.sweep!({
			tenantId: TENANT,
			cutoff: new Date(harness.clock - 30 * DAY),
			limit: 100,
		});
		expect(rowsSweep).toEqual({ removed: 3 });
		expect(
			(await harness.service.rows(TENANT, old.id, 10, null)).items,
		).toEqual([]);
		expect(
			(await harness.service.rows(TENANT, recent.id, 10, null)).items,
		).toHaveLength(3);

		const runsSweep = await classes.get('runs')!.sweep!({
			tenantId: TENANT,
			cutoff: new Date(harness.clock - 90 * DAY),
			limit: 100,
		});
		expect(runsSweep).toEqual({ removed: 1 });
		expect(
			(await harness.service.runs(TENANT, { limit: 10 })).items.map(
				(run) => run.id,
			),
		).toEqual([recent.id]);

		for (const key of ['runs', 'run-rows', 'bindings', 'audit']) {
			const out = sink();
			const summary = await classes.get(key)!.export!({
				tenantId: TENANT,
				sink: out,
			});
			expect([key, summary.rows, out.rows.length > 0]).toEqual([
				key,
				out.rows.length,
				true,
			]);
		}

		for (const key of ['runs', 'bindings', 'audit']) {
			const entry = classes.get(key)!;
			const before = await entry.count!({
				tenantId: TENANT,
				subject: { accountId: OWNER },
			});
			expect([key, (before ?? 0) > 0]).toEqual([key, true]);
			const erased = await entry.erase!({
				tenantId: TENANT,
				subject: { accountId: OWNER },
				limit: 100,
			});
			expect([key, erased.removed, erased.redacted]).toEqual([key, 0, before]);
			expect(
				await entry.count!({ tenantId: TENANT, subject: { accountId: OWNER } }),
			).toBe(0);
		}
		expect(await harness.service.run(TENANT, recent.id)).toMatchObject({
			startedBy: null,
			status: 'succeeded',
		});
	});
});
