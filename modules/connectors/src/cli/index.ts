import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { migrateConnectorsDatabase } from '../services/database-repository.ts';
import { rotateConnectorCredentials } from '../services/credential-rotation.ts';
import { credentialVaultFromEnvironment } from '../services/credential-vault.ts';

const rotateCapability = {
	id: 'connectors.secrets.rotate',
	version: 1,
	summary:
		'Re-seal stored connector credentials with the current encryption key.',
	risk: 'process' as const,
	requiresApprovedSpec: false,
	supportsDryRun: true,
};

interface OpenDatabase {
	readonly leases: readonly DatabaseAdapterLease[];
	readonly runtime: DatabaseAdapterLease;
	readonly background: DatabaseAdapterLease;
}

/* The operator command reads the same deployment database the platform does;
   the runner owns the provider and a module owns no driver, so it arrives on
   the context. It may be the first thing to touch a fresh database, so it
   migrates before reading. */
async function open(context: CliExtensionContext): Promise<OpenDatabase> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'connectors.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const requirements = {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	};
	const migration = await databases.acquire({
		namespace: 'connectors.core',
		purpose: 'migration',
		requirements,
	});
	await migrateConnectorsDatabase(migration.database);
	const runtime = await databases.acquire({
		namespace: 'connectors.core',
		purpose: 'runtime',
		requirements,
	});
	/* The inventory counts rows across the whole deployment, which only the
	   cross-tenant read-only role may do. */
	const background = await databases.acquire({
		namespace: 'connectors.core',
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
	moduleId: 'connectors.core',
	commands: [
		{
			path: ['connectors', 'secrets-rotate'],
			capability: rotateCapability,
			execute: async (context) => {
				/* The report names key ids and row counts only; a credential never
				   reaches the command output. */
				const vault = credentialVaultFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const opened = await open(context);
				try {
					const report = await rotateConnectorCredentials({
						runtime: opened.runtime.database,
						background: opened.background.database,
						vault,
						apply: context.apply,
					});
					const warnings: string[] = [];
					if (report.skipped > 0) {
						warnings.push(
							`${report.skipped} rows were rewritten by the application while this ran and keep their own envelope. Run the command again.`,
						);
					}
					if (report.unknown > 0) {
						warnings.push(
							`${report.unknown} rows are sealed under a key this ring does not hold and were left as they are. Put that key back in FD_CONNECTORS_SECRET_KEY_PREVIOUS before retiring it.`,
						);
					}
					if (report.refused > 0) {
						warnings.push(
							`${report.refused} rows failed authentication under the key they name and were left as they are. Restore them from a database backup or replace the credential.`,
						);
					}
					return {
						data: { moduleId: 'connectors.core', ...report },
						evidence: [
							'modules/connectors/spec/module.yaml',
							'docs/operations.md',
						],
						warnings,
					};
				} finally {
					await close(opened);
				}
			},
		},
	],
});

export default cliExtension;
