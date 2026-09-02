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
import { SqliteExpensesRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-expenses-'));
	return join(workspace, 'expenses.db');
}

function states(path: string): readonly string[] {
	return moduleMigrationStatus(new DatabaseSync(path), migrations).map(
		(entry) => entry.state,
	);
}

describe('expenses migrations', () => {
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

		new SqliteExpensesRepository(path);

		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a database that already carries the schema and rows', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		for (const migration of migrations) before.exec(migration.statements);
		before.exec(`INSERT INTO expenses_claims
	 (id, tenant_id, claimant_id, title, amount_minor, currency, category,
	  expense_date, note, status, decision_comment, created_at)
	 VALUES ('claim-1', 'tenant-a', 'account-1', 'Taxi', 2500, 'EUR', 'travel',
	  '2026-08-01', NULL, 'submitted', NULL, 1)`);
		before.close();

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		new SqliteExpensesRepository(path);

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(migrations.map((migration) => ({ id: migration.id })));
		expect(after.prepare(`SELECT title FROM expenses_claims`).all()).toEqual([
			{ title: 'Taxi' },
		]);
	});

	it('runs clean on a second repository construction', () => {
		const path = databasePath();
		new SqliteExpensesRepository(path);

		expect(() => new SqliteExpensesRepository(path)).not.toThrow();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});
});
