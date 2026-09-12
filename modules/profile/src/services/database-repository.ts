import type { DatabaseHandle } from '@flowdular/database';
import { integer, runDatabaseMigrations } from '@flowdular/database';
import type { Profile, ProfileLanguagePreference } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { ProfileRepository } from './repository.ts';

interface ProfileRow {
	tenant_id: string;
	account_id: string;
	display_name: string;
	updated_at: number | bigint | string;
}

interface ProfileLanguageRow {
	tenant_id: string;
	account_id: string;
	locale: string;
	updated_at: number | bigint | string;
}

/* Queries stay explicit. Profile data never passes through a SQL rewriter, and
   values always use the adapter's parameter channel. */
const FIND = `SELECT tenant_id, account_id, display_name, updated_at
			 FROM profile_records
			 WHERE tenant_id = $1 AND account_id = $2`;

const SAVE = `INSERT INTO profile_records
			 (tenant_id, account_id, display_name, updated_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
			   display_name = excluded.display_name,
			   updated_at = excluded.updated_at`;

const FIND_LANGUAGE = `SELECT tenant_id, account_id, locale, updated_at
			 FROM profile_language_preferences
			 WHERE tenant_id = $1 AND account_id = $2`;

const SAVE_LANGUAGE = `INSERT INTO profile_language_preferences
			 (tenant_id, account_id, locale, updated_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (tenant_id, account_id) DO UPDATE SET
			   locale = excluded.locale,
			   updated_at = excluded.updated_at`;

function fromRow(row: ProfileRow): Profile {
	return {
		tenantId: row.tenant_id,
		accountId: row.account_id,
		displayName: row.display_name,
		updatedAt: integer(row.updated_at, 'updated_at', { min: 0 }),
	};
}

function languageFromRow(row: ProfileLanguageRow): ProfileLanguagePreference {
	return {
		tenantId: row.tenant_id,
		accountId: row.account_id,
		locale: row.locale,
		updatedAt: integer(row.updated_at, 'updated_at', { min: 0 }),
	};
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseProfileRepository implements ProfileRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	async find(tenantId: string, accountId: string): Promise<Profile | null> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ProfileRow>({
					text: FIND,
					parameters: [tenantId, accountId],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async save(profile: Profile): Promise<Profile> {
		await this.readyPromise;
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SAVE,
					parameters: [
						profile.tenantId,
						profile.accountId,
						profile.displayName,
						profile.updatedAt,
					],
				}),
			{ access: 'write', tenantId: profile.tenantId },
		);
		return profile;
	}

	async findLanguage(
		tenantId: string,
		accountId: string,
	): Promise<ProfileLanguagePreference | null> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ProfileLanguageRow>({
					text: FIND_LANGUAGE,
					parameters: [tenantId, accountId],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? languageFromRow(row) : null;
	}

	async saveLanguage(
		preference: ProfileLanguagePreference,
	): Promise<ProfileLanguagePreference> {
		await this.readyPromise;
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SAVE_LANGUAGE,
					parameters: [
						preference.tenantId,
						preference.accountId,
						preference.locale,
						preference.updatedAt,
					],
				}),
			{ access: 'write', tenantId: preference.tenantId },
		);
		return preference;
	}
}

export async function migrateProfileDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'profile.core', databaseMigrations);
}
