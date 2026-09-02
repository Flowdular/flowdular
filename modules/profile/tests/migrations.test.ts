import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationStatus,
} from '@coreloom/kernel';
import { migrations } from '../src/services/migration.ts';
import { SqliteProfileRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-profile-'));
	return join(workspace, 'profile.db');
}

function states(path: string): readonly string[] {
	return moduleMigrationStatus(new DatabaseSync(path), migrations).map(
		(entry) => entry.state,
	);
}

describe('profile migrations', () => {
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

		new SqliteProfileRepository(path);

		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a database that already carries the schema and rows', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		for (const migration of migrations) before.exec(migration.statements);
		before.exec(`INSERT INTO profile_records (tenant_id, account_id, display_name, updated_at)
	 VALUES ('tenant-a', 'account-1', 'Ada', 1)`);
		before.exec(`INSERT INTO profile_language_preferences (tenant_id, account_id, locale, updated_at)
	 VALUES ('tenant-a', 'account-1', 'pl', 1)`);
		before.close();

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		new SqliteProfileRepository(path);

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(migrations.map((migration) => ({ id: migration.id })));
		expect(
			after.prepare(`SELECT display_name FROM profile_records`).all(),
		).toEqual([{ display_name: 'Ada' }]);
		expect(
			after.prepare(`SELECT locale FROM profile_language_preferences`).all(),
		).toEqual([{ locale: 'pl' }]);
	});

	it('runs clean on a second repository construction', () => {
		const path = databasePath();
		new SqliteProfileRepository(path);

		expect(() => new SqliteProfileRepository(path)).not.toThrow();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});
});
