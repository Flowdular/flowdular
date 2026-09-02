import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentToolContext } from '@coreloom/harness/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogAgentTools } from '../src/agent/tools.ts';
import type { CatalogItem } from '../src/domain/types.ts';
import { createCatalogRuntime } from '../src/server/runtime.ts';

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-catalog-idempotency-'));
	return join(workspace, 'catalog.db');
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
		const path = databasePath();
		const firstRuntime = createCatalogRuntime({ databasePath: path });
		const create = catalogAgentTools(firstRuntime)[1]!;
		const first = (await create.execute(
			{ ...input, sku: ' sku-100 ', name: '  Steel bolt  ', currency: 'eur' },
			context('catalog-create-key-1'),
		)) as CatalogItem;
		firstRuntime.dispose();

		const recoveredRuntime = createCatalogRuntime({ databasePath: path });
		const recoveredCreate = catalogAgentTools(recoveredRuntime)[1]!;
		const replay = (await recoveredCreate.execute(
			input,
			context('catalog-create-key-1'),
		)) as CatalogItem;
		expect(replay).toEqual(first);
		expect(recoveredRuntime.service().list('tenant-a')).toEqual([first]);
		expect(
			recoveredRuntime.service().history('tenant-a', {
				recordId: first.id,
				limit: 10,
				cursor: null,
			}).entries,
		).toHaveLength(1);

		await expect(
			recoveredCreate.execute(
				{ ...input, name: 'Different item' },
				context('catalog-create-key-1'),
			),
		).rejects.toMatchObject({ code: 'CATALOG_IDEMPOTENCY_CONFLICT' });
		expect(() =>
			recoveredRuntime
				.service()
				.createIdempotent(
					'tenant-a',
					input,
					context('catalog-create-key-1').actor!,
					{
						key: 'catalog-create-key-1',
						operationId: 'catalog.item.create@2',
					},
				),
		).toThrowError(
			expect.objectContaining({ code: 'CATALOG_IDEMPOTENCY_CONFLICT' }),
		);

		const tenantB = (await recoveredCreate.execute(
			input,
			context('catalog-create-key-1', 'tenant-b'),
		)) as CatalogItem;
		expect(tenantB.tenantId).toBe('tenant-b');
		expect(recoveredRuntime.service().list('tenant-b')).toHaveLength(1);
		recoveredRuntime.dispose();
	});

	it('keeps the ledger after deletion without adding history on replay', async () => {
		const path = databasePath();
		const runtime = createCatalogRuntime({ databasePath: path });
		const create = catalogAgentTools(runtime)[1]!;
		const created = (await create.execute(
			input,
			context('catalog-delete-key-1'),
		)) as CatalogItem;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		runtime.service().archive('tenant-a', created.id, actor);
		runtime.service().delete('tenant-a', created.id, actor);
		expect(runtime.service().list('tenant-a')).toEqual([]);

		expect(
			await create.execute(input, context('catalog-delete-key-1')),
		).toEqual(created);
		expect(runtime.service().list('tenant-a')).toEqual([]);
		expect(
			runtime
				.service()
				.history('tenant-a', {
					recordId: created.id,
					limit: 10,
					cursor: null,
				})
				.entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'created']);
		runtime.dispose();

		const database = new DatabaseSync(path);
		const evidence = database
			.prepare(
				`SELECT tenant_id, idempotency_key, operation_id, input_digest,
				 outcome, result_digest
				 FROM catalog_idempotency_ledger`,
			)
			.get() as Record<string, unknown>;
		expect(evidence).toMatchObject({
			tenant_id: 'tenant-a',
			idempotency_key: 'catalog-delete-key-1',
			operation_id: 'catalog.item.create@1',
			outcome: 'succeeded',
		});
		expect(evidence.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(evidence.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(JSON.stringify(evidence)).not.toContain('Steel bolt');
		database.close();
	});

	it('rolls back the item and history if the ledger cannot commit', async () => {
		const path = databasePath();
		const initialized = createCatalogRuntime({ databasePath: path });
		initialized.service();
		initialized.dispose();
		const database = new DatabaseSync(path);
		database.exec(`CREATE TRIGGER fail_catalog_ledger
		BEFORE INSERT ON catalog_idempotency_ledger
		BEGIN
		  SELECT RAISE(ABORT, 'forced ledger failure');
		END;`);
		database.close();

		const runtime = createCatalogRuntime({ databasePath: path });
		await expect(
			catalogAgentTools(runtime)[1]!.execute(
				input,
				context('catalog-rollback-key-1'),
			),
		).rejects.toThrow();
		expect(runtime.service().list('tenant-a')).toEqual([]);
		runtime.dispose();

		const checked = new DatabaseSync(path);
		expect(
			checked.prepare('SELECT count(*) AS count FROM catalog_items').get(),
		).toEqual({ count: 0 });
		expect(
			checked
				.prepare('SELECT count(*) AS count FROM catalog_items_history_v2')
				.get(),
		).toEqual({ count: 0 });
		expect(
			checked
				.prepare('SELECT count(*) AS count FROM catalog_idempotency_ledger')
				.get(),
		).toEqual({ count: 0 });
		checked.close();
	});

	it('fails closed on a corrupted replay result without recreating the item', async () => {
		const path = databasePath();
		const first = createCatalogRuntime({ databasePath: path });
		const create = catalogAgentTools(first)[1]!;
		const created = (await create.execute(
			input,
			context('catalog-corrupt-key-1'),
		)) as CatalogItem;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		first.service().archive('tenant-a', created.id, actor);
		first.service().delete('tenant-a', created.id, actor);
		first.dispose();

		const tamper = new DatabaseSync(path);
		tamper
			.prepare(
				`UPDATE catalog_idempotency_ledger SET result_json = ?
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.run(
				JSON.stringify({ ...created, name: 'Tampered' }),
				'tenant-a',
				'catalog-corrupt-key-1',
			);
		tamper.close();

		const recovered = createCatalogRuntime({ databasePath: path });
		await expect(
			catalogAgentTools(recovered)[1]!.execute(
				input,
				context('catalog-corrupt-key-1'),
			),
		).rejects.toMatchObject({ code: 'CATALOG_IDEMPOTENCY_LEDGER_CORRUPT' });
		expect(recovered.service().list('tenant-a')).toEqual([]);
		expect(
			await catalogAgentTools(recovered)[1]!.execute(
				input,
				context('catalog-corrupt-key-1', 'tenant-b'),
			),
		).toMatchObject({ tenantId: 'tenant-b' });
		recovered.dispose();
	});
});
