import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationStatus,
} from '@coreloom/kernel';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import { migrations } from '../src/services/migration.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-auth-'));
	return join(workspace, 'auth.db');
}

function open(path: string): DatabaseSync {
	const database = new DatabaseSync(path);
	database.exec('PRAGMA foreign_keys = ON;');
	return database;
}

function states(path: string): readonly string[] {
	return moduleMigrationStatus(open(path), migrations).map(
		(entry) => entry.state,
	);
}

/* The shape a database reaches under the pre-ledger repository: the schema of
   every migration, plus one tenant whose owner already carries the scopes the
   backfill migrations grant. */
function seedPreLedgerDatabase(
	path: string,
	scopes: readonly string[] = OWNER_SCOPES,
): void {
	const database = open(path);
	for (const migration of migrations) database.exec(migration.statements);
	database.exec(
		`INSERT INTO auth_tenants (id, name, slug, created_at) VALUES ('tenant-a', 'Contoso', 'tenant-a', 1);
		 INSERT INTO auth_accounts (id, email, email_normalized, password_hash, display_name, status, created_at)
		 VALUES ('account-1', 'Admin@example.com', 'admin@example.com', 'hash', 'Admin', 'active', 1);
		 INSERT INTO auth_memberships (account_id, tenant_id, role, role_id, created_at)
		 VALUES ('account-1', 'tenant-a', 'owner', 'tenant-a:owner', 1);`,
	);
	const insert = database.prepare(
		'INSERT INTO auth_membership_scopes (account_id, tenant_id, scope) VALUES (?, ?, ?)',
	);
	for (const scope of scopes) insert.run('account-1', 'tenant-a', scope);
	database.close();
}

function scopesOf(path: string): readonly string[] {
	return (
		open(path)
			.prepare(
				'SELECT scope FROM auth_membership_scopes WHERE account_id = ? ORDER BY scope',
			)
			.all('account-1') as unknown as readonly { scope: string }[]
	).map((row) => row.scope);
}

describe('auth migrations', () => {
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

		new SqliteAuthRepository(path);

		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a database written before the ledger existed', () => {
		const path = databasePath();
		seedPreLedgerDatabase(path);

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		new SqliteAuthRepository(path);

		const database = open(path);
		expect(
			database
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(migrations.map((migration) => ({ id: migration.id })));
		expect(
			database
				.prepare('SELECT email, slug FROM auth_accounts, auth_tenants')
				.get(),
		).toEqual({ email: 'Admin@example.com', slug: 'tenant-a' });
		expect(scopesOf(path)).toEqual([...OWNER_SCOPES].sort());
	});

	it('still backfills a membership the scope grants never reached', () => {
		const path = databasePath();
		const missing = OWNER_SCOPES.filter(
			(scope) => scope !== 'users.members.read',
		);
		seedPreLedgerDatabase(path, missing);

		expect(states(path)[1]).toBe('pending');
		new SqliteAuthRepository(path);

		expect(scopesOf(path)).toContain('users.members.read');
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('stops re-running the scope backfills once they are in the ledger', () => {
		const path = databasePath();
		seedPreLedgerDatabase(path);
		new SqliteAuthRepository(path);

		const database = open(path);
		database.exec(
			`INSERT INTO auth_accounts (id, email, email_normalized, password_hash, display_name, status, created_at)
			 VALUES ('account-2', 'member@example.com', 'member@example.com', 'hash', 'Member', 'active', 1);
			 INSERT INTO auth_memberships (account_id, tenant_id, role, role_id, created_at)
			 VALUES ('account-2', 'tenant-a', 'member', 'tenant-a:member', 1);
			 INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
			 VALUES ('account-2', 'tenant-a', 'system.modules.read');`,
		);
		database.close();

		new SqliteAuthRepository(path);

		expect(
			open(path)
				.prepare(
					'SELECT scope FROM auth_membership_scopes WHERE account_id = ?',
				)
				.all('account-2'),
		).toEqual([{ scope: 'system.modules.read' }]);
	});

	it('runs clean on a second repository construction', () => {
		const path = databasePath();
		new SqliteAuthRepository(path);

		expect(() => new SqliteAuthRepository(path)).not.toThrow();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});
});
