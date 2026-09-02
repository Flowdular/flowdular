import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationStatus,
	runModuleMigrations,
} from '@coreloom/kernel';
import { migrations } from '../src/services/migration.ts';
import { CatalogService } from '../src/services/catalog-service.ts';
import { SqliteCatalogRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-catalog-'));
	return join(workspace, 'catalog.db');
}

function states(path: string): readonly string[] {
	return moduleMigrationStatus(new DatabaseSync(path), migrations).map(
		(entry) => entry.state,
	);
}

describe('catalog migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		const files = readdirSync(directory)
			.filter((name) => name.endsWith('.up.sql'))
			.sort();

		expect(migrations.map((migration) => `${migration.id}.up.sql`)).toEqual(
			files,
		);
		for (const migration of migrations) {
			expect(migration.statements).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies every migration on a fresh database', () => {
		const path = databasePath();

		new SqliteCatalogRepository(path);

		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a database that already carries the schema and rows', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		for (const migration of migrations.slice(0, -2)) {
			before.exec(migration.statements);
		}
		before.exec(`INSERT INTO catalog_items
	 (id, tenant_id, sku, sku_normalized, name, kind, unit, base_price_minor, currency, status, created_at)
	 VALUES ('item-1', 'tenant-a', 'SKU-1', 'sku-1', 'Bolt', 'product', 'pcs', 500, 'EUR', 'active', 1)`);
		before.exec(`INSERT INTO catalog_items_history
	 (id, tenant_id, record_id, version, action, actor_kind, actor_id,
	  actor_label, run_id, changes_json, occurred_at)
	 VALUES ('history-1', 'tenant-a', 'item-1', 1, 'created', 'user',
	         'account-1', 'Owner', NULL, '{}', 1)`);
		for (const migration of migrations.slice(-2)) {
			before.exec(migration.statements);
		}
		before.close();

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		const repository = new SqliteCatalogRepository(path);
		expect(
			repository.history({
				tenantId: 'tenant-a',
				recordId: 'item-1',
				limit: 10,
				cursor: null,
			}).entries,
		).toMatchObject([
			{ id: 'history-1', actor: { kind: 'user', id: 'account-1' } },
		]);
		repository.close();

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(migrations.map((migration) => ({ id: migration.id })));
		expect(after.prepare(`SELECT sku FROM catalog_items`).all()).toEqual([
			{ sku: 'SKU-1' },
		]);
	});

	it('round-trips a service actor with its configuring user', () => {
		const repository = new SqliteCatalogRepository(':memory:');
		const service = new CatalogService(repository);
		const actor = {
			kind: 'service',
			id: 'workflow:catalog-sync',
			label: 'Catalog sync',
			configuredBy: {
				kind: 'user',
				id: 'account-1',
				label: 'Owner',
			},
		} as const;
		const item = service.create(
			'tenant-a',
			{
				sku: 'WORKFLOW-1',
				name: 'Workflow item',
				kind: 'product',
				unit: 'pcs',
				basePriceMinor: 100,
				currency: 'EUR',
			},
			actor,
		);

		expect(
			service.history('tenant-a', {
				recordId: item.id,
				limit: 10,
				cursor: null,
			}).entries[0]?.actor,
		).toEqual(actor);
		repository.close();
	});

	it('upgrades an applied legacy history without changing or losing its rows', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		runModuleMigrations(before, migrations.slice(0, -2));
		before.exec(`INSERT INTO catalog_items
	 (id, tenant_id, sku, sku_normalized, name, kind, unit, base_price_minor, currency, status, created_at)
	 VALUES ('item-legacy', 'tenant-a', 'LEGACY-1', 'legacy-1', 'Legacy item', 'product', 'pcs', 100, 'EUR', 'active', 1)`);
		before.exec(`INSERT INTO catalog_items_history
	 (id, tenant_id, record_id, version, action, actor_kind, actor_id,
	  actor_label, run_id, changes_json, occurred_at)
	 VALUES ('history-legacy', 'tenant-a', 'item-legacy', 1, 'created', 'agent',
	         'agent-1', 'Importer', 'run-1', '{}', 1)`);
		before.close();

		const repository = new SqliteCatalogRepository(path);
		expect(repository.list('tenant-a')).toMatchObject([
			{ id: 'item-legacy', name: 'Legacy item' },
		]);
		expect(
			repository.history({
				tenantId: 'tenant-a',
				recordId: 'item-legacy',
				limit: 10,
				cursor: null,
			}).entries,
		).toMatchObject([
			{
				id: 'history-legacy',
				actor: { kind: 'agent', id: 'agent-1', runId: 'run-1' },
			},
		]);
		repository.close();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('runs clean on a second repository construction', () => {
		const path = databasePath();
		new SqliteCatalogRepository(path);

		expect(() => new SqliteCatalogRepository(path)).not.toThrow();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});
});
