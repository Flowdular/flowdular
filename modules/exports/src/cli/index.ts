import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import {
	createStorageKeyring,
	createStoragePort,
	storageConfigFromEnvironment,
} from '@flowdular/storage';
import { migrateExportsDatabase } from '../services/database-repository.ts';
import {
	rotateExportObjects,
	type StorageRotationReport,
} from '../services/storage-rotation.ts';

const rotateCapability = {
	id: 'exports.storage.rotate',
	version: 1,
	summary:
		'Re-seal stored export files with the current storage encryption key.',
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
			'exports.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const requirements = {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	};
	const migration = await databases.acquire({
		namespace: 'exports.core',
		purpose: 'migration',
		requirements,
	});
	await migrateExportsDatabase(migration.database);
	const runtime = await databases.acquire({
		namespace: 'exports.core',
		purpose: 'runtime',
		requirements,
	});
	/* The inventory lists workspaces across the whole deployment, which only
	   the cross-tenant read-only role may do. */
	const background = await databases.acquire({
		namespace: 'exports.core',
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

export function storageRotationWarnings(
	report: StorageRotationReport,
	variable: string,
): string[] {
	const warnings: string[] = [];
	if (report.unknown > 0) {
		warnings.push(
			`${report.unknown} objects are sealed under a key this ring does not hold and were left as they are. Put that key back in ${variable}_PREVIOUS before retiring it.`,
		);
	}
	if (report.refused > 0) {
		warnings.push(
			`${report.refused} objects failed authentication under the key they name and were left as they are. Restore them from the object store backup.`,
		);
	}
	if (report.missing > 0) {
		warnings.push(
			`${report.missing} jobs name a file the store no longer holds.`,
		);
	}
	return warnings;
}

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'exports.core',
	commands: [
		{
			path: ['exports', 'secrets-rotate'],
			capability: rotateCapability,
			execute: async (context) => {
				/* The report names key ids and counts only; no file content reaches
				   the command output. The port is the platform's own, built from the
				   same environment the server reads. */
				const storage = createStoragePort(
					storageConfigFromEnvironment(process.env, context.workspaceRoot),
					{ keyring: createStorageKeyring(process.env, context.workspaceRoot) },
				);
				const opened = await open(context);
				try {
					const report = await rotateExportObjects({
						runtime: opened.runtime.database,
						background: opened.background.database,
						storage,
						apply: context.apply,
					});
					return {
						data: { moduleId: 'exports.core', ...report },
						evidence: [
							'modules/exports/spec/module.yaml',
							'docs/operations.md',
						],
						warnings: storageRotationWarnings(
							report,
							'FD_STORAGE_ENCRYPTION_KEY',
						),
					};
				} finally {
					await close(opened);
					await storage.dispose();
				}
			},
		},
	],
});

export default cliExtension;
