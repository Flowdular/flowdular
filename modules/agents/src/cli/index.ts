import { defineCliExtension } from '@coreloom/cli-protocol';
import { AI_PROVIDER_KINDS } from '@coreloom/harness/catalog';
import { agentRuntimeOptionsFromEnvironment } from '../server/runtime.ts';
import { SqliteProviderRepository } from '../services/provider-repository.ts';
import { SqliteAgentRepository } from '../services/sqlite-repository.ts';

const statusCapability = {
	id: 'agents.status',
	version: 1,
	summary: 'Inspect the agents.core module status.',
	risk: 'read' as const,
	requiresApprovedSpec: false,
	supportsDryRun: false,
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

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'agents.core',
	commands: [
		{
			path: ['agents', 'status'],
			capability: statusCapability,
			execute: (context) => {
				const options = agentRuntimeOptionsFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const repository = new SqliteProviderRepository(options.databasePath);
				try {
					const connections = repository.summary();
					return {
						data: {
							moduleId: 'agents.core',
							status: 'ready',
							queue: 'durable-fire-and-forget',
							builtInProviders: ['local-simulation'],
							providerKinds: [...AI_PROVIDER_KINDS],
							providerConnections: connections.connections,
							enabledProviderConnections: connections.enabled,
							databasePath: options.databasePath,
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
							options.databasePath,
						],
					};
				} finally {
					repository.close();
				}
			},
		},
		{
			path: ['agents', 'audit-verify'],
			capability: auditCapability,
			execute: (context) => {
				const tenant = context.flags.get('tenant');
				if (typeof tenant !== 'string' || tenant.trim().length === 0) {
					throw new Error('--tenant <id> is required.');
				}
				const options = agentRuntimeOptionsFromEnvironment(
					process.env,
					context.workspaceRoot,
				);
				const repository = new SqliteAgentRepository(options.databasePath);
				try {
					const events = repository.listAuditEvents(tenant, 250);
					return {
						data: {
							tenantId: tenant,
							valid: repository.verifyAuditChain(tenant),
							eventsInspected: events.length,
							latestSequence: events[0]?.sequence ?? 0,
						},
						evidence: ['.coreloom/data/agents.db'],
					};
				} finally {
					repository.close();
				}
			},
		},
	],
});

export default cliExtension;
