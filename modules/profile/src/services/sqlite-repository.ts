import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runModuleMigrations } from '@coreloom/kernel';
import type { Profile, ProfileLanguagePreference } from '../domain/types.ts';
import { migrations } from './migration.ts';
import type { ProfileRepository } from './repository.ts';

interface ProfileRow {
	tenant_id: string;
	account_id: string;
	display_name: string;
	updated_at: number;
}

interface ProfileLanguageRow {
	tenant_id: string;
	account_id: string;
	locale: string;
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

function languageFromRow(row: ProfileLanguageRow): ProfileLanguagePreference {
	return {
		tenantId: row.tenant_id,
		accountId: row.account_id,
		locale: row.locale,
		updatedAt: row.updated_at,
	};
}

export class SqliteProfileRepository implements ProfileRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
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

	findLanguage(
		tenantId: string,
		accountId: string,
	): ProfileLanguagePreference | null {
		const row = this.#database
			.prepare(
				`SELECT tenant_id, account_id, locale, updated_at
				 FROM profile_language_preferences
				 WHERE tenant_id = ? AND account_id = ?`,
			)
			.get(tenantId, accountId) as unknown as ProfileLanguageRow | undefined;
		return row ? languageFromRow(row) : null;
	}

	saveLanguage(
		preference: ProfileLanguagePreference,
	): ProfileLanguagePreference {
		this.#database
			.prepare(
				`INSERT INTO profile_language_preferences
				 (tenant_id, account_id, locale, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
				   locale = excluded.locale,
				   updated_at = excluded.updated_at`,
			)
			.run(
				preference.tenantId,
				preference.accountId,
				preference.locale,
				preference.updatedAt,
			);
		return preference;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}
