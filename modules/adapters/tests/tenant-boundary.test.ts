import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import { OTHER_TENANT, principal, TENANT } from './support/fakes.ts';
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

describe('ADAPTERS-TENANT-BOUNDARY', () => {
	it('shows each workspace only its own bindings, runs, rows and events and rejects a foreign tenant id', async () => {
		const harness = serviceHarness(database);
		harness.principals.set(
			'account-other',
			principal(undefined, OTHER_TENANT, 'account-other'),
		);
		const runs: Record<string, string> = {};
		for (const [tenantId, accountId] of [
			[TENANT, 'account-owner'],
			[OTHER_TENANT, 'account-other'],
		] as const) {
			const actor = principal(undefined, tenantId, accountId);
			await harness.service.bind(actor, {
				adapterId: SOURCE_ID,
				instanceId: null,
				enabled: true,
				mapping: null,
				schedule: null,
			});
			runs[tenantId] = (await harness.service.start(actor, SOURCE_ID)).id;
			await harness.runs().tick();
		}

		for (const table of [
			'adapter_bindings',
			'adapter_runs',
			'adapter_run_rows',
			'adapter_audit_events',
		]) {
			const visible = await database.runtime.transaction(
				(transaction) =>
					transaction.query<{ tenant_id: string }>({
						text: `SELECT tenant_id FROM ${table}`,
					}),
				{ access: 'read', tenantId: TENANT },
			);
			expect([
				table,
				[...new Set(visible.rows.map((row) => row.tenant_id))],
			]).toEqual([table, [TENANT]]);
		}
		expect(
			(await harness.service.runs(TENANT, { limit: 10 })).items.map(
				(run) => run.id,
			),
		).toEqual([runs[TENANT]]);
		await expect(
			harness.service.run(TENANT, runs[OTHER_TENANT]!),
		).rejects.toMatchObject({
			code: 'ADAPTER_RUN_NOT_FOUND',
		});
		await expect(
			harness.service.rows(TENANT, runs[OTHER_TENANT]!, 10, null),
		).rejects.toMatchObject({ code: 'ADAPTER_RUN_NOT_FOUND' });
		await expect(
			harness.service.cancel(principal(), runs[OTHER_TENANT]!),
		).rejects.toMatchObject({ code: 'ADAPTER_RUN_NOT_FOUND' });

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO adapter_bindings
						       (tenant_id, adapter_id, instance_id, enabled, mapping_json, schedule,
						        next_run_at, updated_by, updated_at)
						       VALUES ($1, 'vendors.core.planted', NULL, 0, NULL, NULL, NULL, NULL, 1)`,
						parameters: [OTHER_TENANT],
					}),
				{ access: 'write', tenantId: TENANT },
			),
		).rejects.toThrow();
	});

	it('lets the background role read routing columns across workspaces and no other column', async () => {
		const harness = serviceHarness(database);
		await harness.service.bind(principal(), {
			adapterId: SOURCE_ID,
			instanceId: null,
			enabled: true,
			mapping: null,
			schedule: null,
		});
		await harness.service.start(principal(), SOURCE_ID);
		expect(
			await database.repository.listPendingRuns(Date.now() + 1, 10),
		).toHaveLength(1);
		await expect(
			database.background.query({ text: 'SELECT cursor FROM adapter_runs' }),
		).rejects.toThrow();
		await expect(
			database.background.query({
				text: 'SELECT mapping_json FROM adapter_bindings',
			}),
		).rejects.toThrow();
	});
});
