import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationStatus,
} from '@coreloom/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { migrations } from '../src/services/migration.ts';
import { createWorkflowPayloadCodec } from '../src/services/payload-codec.ts';
import { SqliteWorkflowsRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);
const payloadCodec = createWorkflowPayloadCodec(Buffer.alloc(32, 71));

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-workflows-'));
	return join(workspace, 'workflows.db');
}

function states(path: string): readonly string[] {
	const database = new DatabaseSync(path);
	try {
		return moduleMigrationStatus(database, migrations).map(
			(entry) => entry.state,
		);
	} finally {
		database.close();
	}
}

describe('workflows migrations', () => {
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

	it('applies on a fresh database and is unchanged on second construction', () => {
		const path = databasePath();
		const first = new SqliteWorkflowsRepository(path, payloadCodec);
		first.close();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));

		const second = new SqliteWorkflowsRepository(path, payloadCodec);
		second.close();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a complete pre-ledger schema without replaying or losing data', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		for (const migration of migrations) before.exec(migration.statements);
		before
			.prepare(
				`INSERT INTO workflow_definitions
				 (id, tenant_id, workflow_key, name, description, status,
				  current_draft_revision, published_revision, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'active', 1, NULL, 1, 1)`,
			)
			.run('workflow-1', 'tenant-a', 'adopted-flow', 'Adopted', 'Kept');
		before.close();

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		const repository = new SqliteWorkflowsRepository(path, payloadCodec);
		expect(repository.findDefinition('tenant-a', 'workflow-1')).toMatchObject({
			key: 'adopted-flow',
			name: 'Adopted',
			description: 'Kept',
		});
		repository.close();

		const after = new DatabaseSync(path);
		try {
			expect(
				after
					.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
					.all(),
			).toEqual(migrations.map((migration) => ({ id: migration.id })));
			expect(
				after.prepare('SELECT name FROM workflow_definitions').all(),
			).toEqual([{ name: 'Adopted' }]);
		} finally {
			after.close();
		}
	});

	it('reports checksum drift before opening the repository', () => {
		const path = databasePath();
		const repository = new SqliteWorkflowsRepository(path, payloadCodec);
		repository.close();
		const database = new DatabaseSync(path);
		database
			.prepare(`UPDATE ${MIGRATION_LEDGER_TABLE} SET checksum = ? WHERE id = ?`)
			.run('sha256:edited', migrations[0]!.id);
		database.close();

		expect(() => new SqliteWorkflowsRepository(path, payloadCodec)).toThrow(
			/checksum|immutable/i,
		);
		expect(states(path)).toEqual(['mismatch', 'applied']);
	});
});
