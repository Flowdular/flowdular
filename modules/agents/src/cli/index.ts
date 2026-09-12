import {
	defineCliExtension,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
} from '@flowdular/database';
import { AI_PROVIDER_KINDS } from '@flowdular/harness/catalog';
import { agentRuntimeOptionsFromEnvironment } from '../server/runtime.ts';
import { rotateProviderCredentials } from '../services/credential-rotation.ts';
import { credentialVaultFromEnvironment } from '../services/credential-vault.ts';
import { DatabaseProviderRepository } from '../services/provider-repository.ts';
import {
	DatabaseAgentRepository,
	migrateAgentsDatabase,
} from '../services/database-repository.ts';

const statusCapability = {
	id: 'agents.status',
	version: 1,
	summary: 'Inspect the agents.core module status.',
	risk: 'read' as const,
	requiresApprovedSpec: false,
	supportsDryRun: false,
};

const rotateCapability = {
	id: 'agents.secrets.rotate',
	version: 1,
	summary:
		'Re-seal stored provider credentials with the current encryption key.',
	risk: 'process' as const,
	requiresApprovedSpec: false,
	supportsDryRun: true,
};

const auditCapability = {
	id: 'agents.audit.verify',
	version: 1,
	summary: 'Verify the local tenant-scoped agent audit hash chain.',
	risk: 'read' as const,
	requiresApprovedSpec: false,
	supportsDryRun: false,
	localOnly: true,
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
			'agents.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const requirements = {
		dialectIds: [DATABASE_DIALECT_IDS.postgresql],
		capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
	};
	const migration = await databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
		requirements,
	});
	await migrateAgentsDatabase(migration.database);
	const runtime = await databases.acquire({
		namespace: 'agents.core',
		purpose: 'runtime',
		requirements,
	});
	/* The status command counts across the whole deployment, which only the
	   narrow read-only role may do. */
	const background = await databases.acquire({
		namespace: 'agents.core',
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
	moduleId: 'agents.core',
	commands: [
		{
			path: ['agents', 'status'],
			capability: statusCapability,
			execute: async (context) => {
				const options = agentRuntimeOptionsFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const opened = await open(context);
				try {
					const connections = await new DatabaseProviderRepository(
						opened.runtime.database,
						Promise.resolve(),
						opened.background.database,
					).summary();
					return {
						data: {
							moduleId: 'agents.core',
							status: 'ready',
							queue: 'durable-fire-and-forget',
							builtInProviders: ['local-simulation'],
							providerKinds: [...AI_PROVIDER_KINDS],
							providerConnections: connections.connections,
							enabledProviderConnections: connections.enabled,
							workerConcurrency: options.workerConcurrency,
							businessDataAccess: [
								'registered-api-tool',
								'registered-cli-tool',
							],
							directBusinessDatabaseAccess: false,
						},
						evidence: [
							'modules/agents/spec/module.yaml',
							'packages/harness/src/runtime.ts',
						],
					};
				} finally {
					await close(opened);
				}
			},
		},
		{
			path: ['agents', 'secrets-rotate'],
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
					const report = await rotateProviderCredentials({
						runtime: opened.runtime.database,
						background: opened.background.database,
						vault,
						apply: context.apply,
					});
					return {
						data: { moduleId: 'agents.core', ...report },
						evidence: ['modules/agents/spec/module.yaml', 'docs/operations.md'],
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
		{
			path: ['agents', 'audit-verify'],
			capability: auditCapability,
			execute: async (context) => {
				const tenant = context.flags.get('tenant');
				if (typeof tenant !== 'string' || tenant.trim().length === 0) {
					throw new Error('--tenant <id> is required.');
				}
				const opened = await open(context);
				try {
					const repository = new DatabaseAgentRepository({
						runtime: opened.runtime.database,
						background: opened.background.database,
					});
					const events = await repository.listAuditEvents(tenant, 250);
					return {
						data: {
							tenantId: tenant,
							valid: await repository.verifyAuditChain(tenant),
							eventsInspected: events.length,
							latestSequence: events[0]?.sequence ?? 0,
						},
						evidence: ['modules/agents/spec/module.yaml'],
					};
				} finally {
					await close(opened);
				}
			},
		},
	],
});

export default cliExtension;
