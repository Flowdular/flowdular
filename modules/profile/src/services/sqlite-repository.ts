import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Profile } from '../domain/types.ts';
import { PROFILE_MIGRATION_001 } from './migration.ts';
import type { ProfileRepository } from './repository.ts';

interface ProfileRow {
	tenant_id: string;
	account_id: string;
	display_name: string;
	updated_at: number;
}

function fromRow(row: ProfileRow): Profile {
	return {
		tenantId: row.tenant_id,
		accountId: row.account_id,
		displayName: row.display_name,
		updatedAt: row.updated_at,
	};
}

export class SqliteProfileRepository implements ProfileRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(PROFILE_MIGRATION_001);
	}

	find(tenantId: string, accountId: string): Profile | null {
		const row = this.#database
			.prepare(
				`SELECT tenant_id, account_id, display_name, updated_at
				 FROM profile_records
				 WHERE tenant_id = ? AND account_id = ?`,
			)
			.get(tenantId, accountId) as unknown as ProfileRow | undefined;
		return row ? fromRow(row) : null;
	}

	save(profile: Profile): Profile {
		this.#database
			.prepare(
				`INSERT INTO profile_records
				 (tenant_id, account_id, display_name, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
				   display_name = excluded.display_name,
				   updated_at = excluded.updated_at`,
			)
			.run(
				profile.tenantId,
				profile.accountId,
				profile.displayName,
				profile.updatedAt,
			);
		return profile;
	}
}
