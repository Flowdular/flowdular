import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATION_LEDGER_TABLE, runModuleMigrations } from '@coreloom/kernel';
import {
	AUTOMATIONS_MIGRATION_001,
	migrations,
} from '../src/services/migration.ts';
import { SqliteAutomationsRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);
let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-automations-targets-'));
	return join(workspace, 'automations.db');
}

describe('automations migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of migrations) {
			expect(migration.statements).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies the target migration and records it in the ledger', () => {
		const database = new DatabaseSync(':memory:');
		runModuleMigrations(database, migrations);
		const scheduleColumns = database
			.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
			.all('automations_schedules') as unknown as readonly {
			readonly name: string;
		}[];
		expect(scheduleColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				'target_kind',
				'target_key',
				'configured_by_json',
				'permission_snapshot_json',
			]),
		);
		expect(
			database
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(migrations.map((migration) => ({ id: migration.id })));
	});

	it('upgrades legacy agent rows without changing their target identity', () => {
		const path = databasePath();
		const database = new DatabaseSync(path);
		database.exec(AUTOMATIONS_MIGRATION_001);
		database.exec(`INSERT INTO automations_schedules
		(id, tenant_id, agent_id, label, input_template, cadence, enabled,
		 next_run_at, created_at, updated_at, created_by)
		VALUES ('schedule-1', 'tenant-a', 'agent-1', 'Legacy', '{}', 'every:60',
		        1, 1000, 1, 1, 'owner-1')`);
		database.exec(`INSERT INTO automations_triggers
		(id, tenant_id, agent_id, label, secret_key_id, secret_iv, secret_tag,
		 secret_ciphertext, secret_revision, enabled, created_at, updated_at,
		 created_by)
		VALUES ('trigger-1', 'tenant-a', 'agent-1', 'Legacy webhook', 'key-1',
		        'iv', 'tag', 'ciphertext', 1, 1, 1, 1, 'owner-1')`);
		database.close();

		const repository = new SqliteAutomationsRepository(path);
		expect(repository.listSchedules('tenant-a')).toMatchObject([
			{
				id: 'schedule-1',
				agentId: 'agent-1',
				targetKind: 'agent',
				targetKey: 'agent-1',
				configuredBy: { kind: 'user', id: 'owner-1', label: 'owner-1' },
				permissionSnapshot: [],
			},
		]);
		expect(repository.listTriggers('tenant-a')).toMatchObject([
			{
				id: 'trigger-1',
				agentId: 'agent-1',
				targetKind: 'agent',
				targetKey: 'agent-1',
				configuredBy: { kind: 'user', id: 'owner-1', label: 'owner-1' },
				permissionSnapshot: [],
			},
		]);
		repository.close();

		expect(() => new SqliteAutomationsRepository(path).close()).not.toThrow();
	});
});
