import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	runDatabaseMigrations,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { databaseMigrations } from '../services/migration.ts';
import { rotateWebhookSecrets } from '../services/secret-rotation.ts';
import { secretVaultFromEnvironment } from '../services/secret-vault.ts';

const rotateCapability = {
	id: 'notifications.secrets.rotate',
	version: 1,
	summary:
		'Re-seal stored webhook signing secrets with the current encryption key.',
	risk: 'process' as const,
	requiresApprovedSpec: false,
	supportsDryRun: true,
};

interface OpenDatabase {
	readonly leases: readonly DatabaseAdapterLease[];
	readonly runtime: DatabaseAdapterLease;
	readonly background: DatabaseAdapterLease;
}

/* The operator commands read the same deployment database the platform does;
   there is no module-owned file to open. The runner owns the provider and a
   module owns no driver, so it arrives on the context.

   A run that applies nothing applies no schema either: it verifies the ledger
   and stops, so a dry run can never be what creates this module's tables. */
async function open(context: CliExtensionContext): Promise<OpenDatabase> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'notifications.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const requirements = {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	};
	const migration = await databases.acquire({
		namespace: 'notifications.core',
		purpose: 'migration',
		requirements,
	});
	const state = await runDatabaseMigrations(
		migration.database,
		'notifications.core',
		databaseMigrations,
		{ dryRun: !context.apply },
	);
	if (!context.apply && state.some((entry) => entry.action === 'applied')) {
		await migration.release();
		throw new Error(
			'notifications.core has no schema in this deployment yet. Start the platform, or run the command with --apply, to create it.',
		);
	}
	const runtime = await databases.acquire({
		namespace: 'notifications.core',
		purpose: 'runtime',
		requirements,
	});
	/* The inventory counts rows across the whole deployment, which only the
	   cross-tenant read-only role may do. */
	const background = await databases.acquire({
		namespace: 'notifications.core',
		purpose: 'background',
		requirements,
	});
	return { leases: [migration, runtime, background], runtime, background };
}

/* The provider belongs to the runner; only the leases this command took are
   released here. */
async function close(open: OpenDatabase): Promise<void> {
	for (const lease of open.leases) await lease.release();
}

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'notifications.core',
	commands: [
		{
			path: ['notifications', 'secrets-rotate'],
			capability: rotateCapability,
			execute: async (context) => {
				/* The report names key ids and row counts only; a secret never
				   reaches the command output. */
				const vault = secretVaultFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const opened = await open(context);
				try {
					const report = await rotateWebhookSecrets({
						runtime: opened.runtime.database,
						background: opened.background.database,
						vault,
						apply: context.apply,
					});
					return {
						data: { moduleId: 'notifications.core', ...report },
						evidence: ['modules/notifications/spec/module.yaml', 'docs/cli.md'],
						warnings:
							report.skipped > 0
								? [
										`${report.skipped} rows were rewritten by the application while this ran and keep their own envelope. Run the command again.`,
									]
								: [],
					};
				} finally {
					await close(opened);
				}
			},
		},
	],
});

export default cliExtension;
