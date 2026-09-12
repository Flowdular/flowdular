import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { workflowPayloadCodecFromEnvironment } from '../server/runtime.ts';
import { migrateWorkflowsDatabase } from '../services/database-repository.ts';
import { rotateWorkflowPayloads } from '../services/payload-rotation.ts';

const rotateCapability = {
	id: 'workflows.secrets.rotate',
	version: 1,
	summary: 'Re-seal stored run payloads with the current encryption key.',
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
   module owns no driver, so it arrives on the context. An operator command may
   be the first thing to touch a fresh database, so it migrates before reading. */
async function open(context: CliExtensionContext): Promise<OpenDatabase> {
	const databases = context.databases;
	if (!databases) {
		throw new Error(
			'workflows.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const requirements = {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	};
	const migration = await databases.acquire({
		namespace: 'workflows.core',
		purpose: 'migration',
		requirements,
	});
	await migrateWorkflowsDatabase(migration.database);
	const runtime = await databases.acquire({
		namespace: 'workflows.core',
		purpose: 'runtime',
		requirements,
	});
	/* The inventory counts payloads across the whole deployment, which only the
	   cross-tenant read-only role may do. */
	const background = await databases.acquire({
		namespace: 'workflows.core',
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
	moduleId: 'workflows.core',
	commands: [
		{
			path: ['workflows', 'secrets-rotate'],
			capability: rotateCapability,
			execute: async (context) => {
				/* The report names key ids and payload counts only; a stored payload
				   never reaches the command output. */
				const codec = workflowPayloadCodecFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const opened = await open(context);
				try {
					const report = await rotateWorkflowPayloads({
						runtime: opened.runtime.database,
						background: opened.background.database,
						codec,
						apply: context.apply,
					});
					return {
						data: { moduleId: 'workflows.core', ...report },
						evidence: [
							'modules/workflows/spec/module.yaml',
							'docs/operations.md',
						],
						warnings:
							report.skipped > 0
								? [
										`${report.skipped} payloads were rewritten or expired while this ran and keep their own envelope. Run the command again.`,
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
