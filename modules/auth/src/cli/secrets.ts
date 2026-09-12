import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { migrateAuthDatabase } from '../services/database-repository.ts';
import { rotateMfaSecrets } from '../services/mfa-rotation.ts';
import { rotateProviderSecrets } from '../services/provider-secret-rotation.ts';
import { providerSecretVaultFromEnvironment } from '../services/provider-secrets.ts';
import { mfaSecretVaultFromEnvironment } from '../services/totp.ts';
import { MIGRATION_REQUIREMENTS } from './database.ts';

const RUNTIME_REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
} as const;

interface OpenedLeases {
	readonly runtime: DatabaseAdapterLease;
	/** Answers which workspaces exist; the provider rows are read per workspace. */
	readonly background: DatabaseAdapterLease;
}

/* An enrolled factor is account data with no workspace column, so the runtime
   lease the auth repository already uses reaches every row. A provider row is
   workspace data under a forced policy, so the run walks the workspaces the
   read-only role lists. An operator command may be the first thing to touch a
   fresh database, so the schema is brought up first and the migration lease
   goes back before any row is read. */
async function openLeases(context: CliExtensionContext): Promise<OpenedLeases> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'auth.core operator commands use the deployment database, and this workspace has none configured.',
		);
	}
	const migration = await databases.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
		requirements: MIGRATION_REQUIREMENTS,
	});
	try {
		await migrateAuthDatabase(migration.database);
	} finally {
		await migration.release();
	}
	const runtime = await databases.acquire({
		namespace: 'auth.core',
		purpose: 'runtime',
		requirements: RUNTIME_REQUIREMENTS,
	});
	try {
		const background = await databases.acquire({
			namespace: 'auth.core',
			purpose: 'background',
			requirements: RUNTIME_REQUIREMENTS,
		});
		return { runtime, background };
	} catch (error) {
		await runtime.release();
		throw error;
	}
}

export async function rotateMfaSecretsCommand(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	/* Both reports name key ids and row counts only; a TOTP secret, a provider
	   secret and the key material itself never reach the command output. */
	const vault = mfaSecretVaultFromEnvironment(process.env);
	const providerVault = providerSecretVaultFromEnvironment(process.env);
	const leases = await openLeases(context);
	try {
		const report = await rotateMfaSecrets({
			database: leases.runtime.database,
			vault,
			apply: context.apply,
		});
		const providers = await rotateProviderSecrets({
			database: leases.runtime.database,
			tenants: async () =>
				(
					await leases.background.database.query<{ id: string }>({
						text: 'SELECT id FROM auth_tenants ORDER BY id',
					})
				).rows.map((row) => row.id),
			vault: providerVault,
			apply: context.apply,
		});
		return {
			data: { moduleId: 'auth.core', ...report, providers },
			evidence: ['modules/auth/spec/module.yaml', 'docs/operations.md'],
			warnings: [
				...(report.skipped > 0
					? [
							`${report.skipped} factors were re-enrolled while this ran and keep their own envelope. Run the command again.`,
						]
					: []),
				...(providers.skipped > 0
					? [
							`${providers.skipped} provider secrets were rotated while this ran and keep their own envelope. Run the command again.`,
						]
					: []),
			],
		};
	} finally {
		await leases.background.release();
		await leases.runtime.release();
	}
}
