import type {
	DatabaseSession,
	DatabaseProvider,
} from '@flowdular/sdk/database';
import type { AgentToolContext } from '@flowdular/sdk/harness/runtime';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { catalogAgentTools } from '../src/agent/tools.ts';
import type { CatalogItem } from '../src/domain/types.ts';
import {
	createCatalogRuntime,
	type CatalogRuntime,
} from '../src/server/runtime.ts';
import {
	catalogTestProvider,
	closeCatalogTestDatabases,
} from './support/database.ts';

const runtimes = new Set<CatalogRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
});

afterAll(closeCatalogTestDatabases);

/* A second runtime on the same cluster is what a restart looks like to the
   module: the process is new, the durable ledger is not. */
function catalogRuntime(databases: DatabaseProvider): CatalogRuntime {
	const runtime = createCatalogRuntime({ databases, purpose: 'test' });
	runtimes.add(runtime);
	return runtime;
}

/* DDL needs the owner; tenant data still needs a tenant, even for its owner. */
async function withMigrationLease<T>(
	databases: DatabaseProvider,
	work: (database: DatabaseSession) => Promise<T>,
): Promise<T> {
	const lease = await databases.acquire({
		namespace: 'catalog.core',
		purpose: 'migration',
	});
	try {
		return await lease.database.transaction(work, {
			tenantId: 'tenant-a',
			access: 'write',
		});
	} finally {
		await lease.release();
	}
}

async function rowCounts(
	databases: DatabaseProvider,
): Promise<Record<string, number>> {
	const row = await withMigrationLease(
		databases,
		async (database) =>
			(
				await database.query<Record<string, string>>({
					text: `SELECT (SELECT count(*) FROM catalog_items) AS items,
						 (SELECT count(*) FROM catalog_items_history_v2) AS history,
						 (SELECT count(*) FROM catalog_idempotency_ledger) AS ledger`,
				})
			).rows[0],
	);
	return {
		items: Number(row?.items),
		history: Number(row?.history),
		ledger: Number(row?.ledger),
	};
}

function context(key: string, tenantId = 'tenant-a'): AgentToolContext {
	return {
		runId: 'run-1',
		tenantId,
		requestedBy: 'account-1',
		idempotencyKey: key,
		actor: {
			kind: 'agent',
			id: 'catalog-agent',
			label: 'Catalog agent',
			runId: 'run-1',
		},
		permissions: new Set(['catalog.items.manage']),
		signal: new AbortController().signal,
	};
}

const input = {
	sku: 'SKU-100',
	name: 'Steel bolt',
	kind: 'product' as const,
	unit: 'pcs',
	basePriceMinor: 250,
	currency: 'EUR',
};

describe('catalog target idempotency', () => {
	it('returns the first result after restart and refuses key reuse for another input or operation', async () => {
		const databases = await catalogTestProvider();
		const firstRuntime = catalogRuntime(databases);
		const create = catalogAgentTools(firstRuntime)[1]!;
		const first = (await create.execute(
			{ ...input, sku: ' sku-100 ', name: '  Steel bolt  ', currency: 'eur' },
			context('catalog-create-key-1'),
		)) as CatalogItem;
		await firstRuntime.dispose();

		const recoveredRuntime = catalogRuntime(databases);
		const recoveredCreate = catalogAgentTools(recoveredRuntime)[1]!;
		const replay = (await recoveredCreate.execute(
			input,
			context('catalog-create-key-1'),
		)) as CatalogItem;
		expect(replay).toEqual(first);
		await expect(
			(await recoveredRuntime.service()).list('tenant-a'),
		).resolves.toEqual([first]);
		expect(
			(
				await (
					await recoveredRuntime.service()
				).history('tenant-a', {
					recordId: first.id,
					limit: 10,
					cursor: null,
				})
			).entries,
		).toHaveLength(1);

		await expect(
			recoveredCreate.execute(
				{ ...input, name: 'Different item' },
				context('catalog-create-key-1'),
			),
		).rejects.toMatchObject({ code: 'CATALOG_IDEMPOTENCY_CONFLICT' });
		await expect(
			(await recoveredRuntime.service()).createIdempotent(
				'tenant-a',
				input,
				context('catalog-create-key-1').actor!,
				{
					key: 'catalog-create-key-1',
					operationId: 'catalog.item.create@2',
				},
			),
		).rejects.toMatchObject({ code: 'CATALOG_IDEMPOTENCY_CONFLICT' });

		const tenantB = (await recoveredCreate.execute(
			input,
			context('catalog-create-key-1', 'tenant-b'),
		)) as CatalogItem;
		expect(tenantB.tenantId).toBe('tenant-b');
		await expect(
			(await recoveredRuntime.service()).list('tenant-b'),
		).resolves.toHaveLength(1);
	});

	it('keeps the ledger after deletion without adding history on replay', async () => {
		const databases = await catalogTestProvider();
		const runtime = catalogRuntime(databases);
		const create = catalogAgentTools(runtime)[1]!;
		const created = (await create.execute(
			input,
			context('catalog-delete-key-1'),
		)) as CatalogItem;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		await (await runtime.service()).archive('tenant-a', created.id, actor);
		await (await runtime.service()).delete('tenant-a', created.id, actor);
		await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
			[],
		);

		expect(
			await create.execute(input, context('catalog-delete-key-1')),
		).toEqual(created);
		await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
			[],
		);
		expect(
			(
				await (
					await runtime.service()
				).history('tenant-a', {
					recordId: created.id,
					limit: 10,
					cursor: null,
				})
			).entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'created']);

		const evidence = await withMigrationLease(
			databases,
			async (database) =>
				(
					await database.query<Record<string, unknown>>({
						text: `SELECT tenant_id, idempotency_key, operation_id, input_digest,
							 outcome, result_digest
							 FROM catalog_idempotency_ledger`,
					})
				).rows[0],
		);
		expect(evidence).toMatchObject({
			tenant_id: 'tenant-a',
			idempotency_key: 'catalog-delete-key-1',
			operation_id: 'catalog.item.create@1',
			outcome: 'succeeded',
		});
		expect(evidence?.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(evidence?.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(JSON.stringify(evidence)).not.toContain('Steel bolt');
	});

	it('rolls back the item and history if the ledger cannot commit', async () => {
		const databases = await catalogTestProvider();
		const runtime = catalogRuntime(databases);
		await runtime.service();
		/* The ledger is empty here, so an always-false constraint only ever
		   rejects the write the tool is about to attempt. */
		await withMigrationLease(databases, (database) =>
			database.execute({
				text: `ALTER TABLE catalog_idempotency_ledger
					 ADD CONSTRAINT forced_ledger_failure CHECK (false) NOT VALID`,
			}),
		);

		try {
			await expect(
				catalogAgentTools(runtime)[1]!.execute(
					input,
					context('catalog-rollback-key-1'),
				),
			).rejects.toThrow(/forced_ledger_failure/);
			await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
				[],
			);
			expect(await rowCounts(databases)).toEqual({
				items: 0,
				history: 0,
				ledger: 0,
			});
		} finally {
			await withMigrationLease(databases, (database) =>
				database.execute({
					text: `ALTER TABLE catalog_idempotency_ledger
						 DROP CONSTRAINT forced_ledger_failure`,
				}),
			);
		}
	});

	it('fails closed on a corrupted replay result without recreating the item', async () => {
		const databases = await catalogTestProvider();
		const first = catalogRuntime(databases);
		const create = catalogAgentTools(first)[1]!;
		const created = (await create.execute(
			input,
			context('catalog-corrupt-key-1'),
		)) as CatalogItem;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		await (await first.service()).archive('tenant-a', created.id, actor);
		await (await first.service()).delete('tenant-a', created.id, actor);
		await first.dispose();

		await withMigrationLease(databases, (database) =>
			database.execute({
				text: `UPDATE catalog_idempotency_ledger SET result_json = $1
					 WHERE tenant_id = $2 AND idempotency_key = $3`,
				parameters: [
					JSON.stringify({ ...created, name: 'Tampered' }),
					'tenant-a',
					'catalog-corrupt-key-1',
				],
			}),
		);

		const recovered = catalogRuntime(databases);
		await expect(
			catalogAgentTools(recovered)[1]!.execute(
				input,
				context('catalog-corrupt-key-1'),
			),
		).rejects.toMatchObject({ code: 'CATALOG_IDEMPOTENCY_LEDGER_CORRUPT' });
		await expect((await recovered.service()).list('tenant-a')).resolves.toEqual(
			[],
		);
		expect(
			await catalogAgentTools(recovered)[1]!.execute(
				input,
				context('catalog-corrupt-key-1', 'tenant-b'),
			),
		).toMatchObject({ tenantId: 'tenant-b' });
	});
});
