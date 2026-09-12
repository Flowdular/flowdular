import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseProvider,
} from '@flowdular/database';
import type { ModuleAgentDefinition } from '../domain/types.ts';
import {
	moduleAgentDefinitionHash,
	normalizeModuleAgentDefinitions,
} from '../server/define-agent.ts';

interface StoredModuleAgentDefinition {
	readonly definition_revision: number | bigint | string;
	readonly content_hash: string;
}

/* The catalogue has no tenant column; the repository reconciles it under this
   sentinel tenant on the runtime handle, so the boot read uses the same one. */
const MODULE_AGENT_CATALOG_TENANT = '__flowdular_module_agents__';

/* Validate persisted revision high-water marks before HMR retires the healthy
   generation. This read is deliberately the only database work the new
   generation does up front: migrations, reconciliation, vault access, workers
   and timers still begin only after the old generation has released its
   resources. */
export async function preflightModuleAgentDefinitions(
	databases: DatabaseProvider | undefined,
	definitions: readonly ModuleAgentDefinition[],
): Promise<readonly ModuleAgentDefinition[]> {
	const normalized = normalizeModuleAgentDefinitions(definitions);
	if (!databases || normalized.length === 0) return normalized;

	const lease = await databases.acquire({
		namespace: 'agents.core',
		purpose: 'runtime',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [
				DATABASE_CAPABILITY_IDS.TRANSACTIONS,
				DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
			],
		},
	});
	try {
		const stored = await lease.database.transaction(
			async (transaction) => {
				/* A first run has no catalog table yet, and that is not a downgrade. */
				if (!(await transaction.schema.hasTable('module_agent_definitions'))) {
					return undefined;
				}
				return transaction.query<
					StoredModuleAgentDefinition & { agent_id: string }
				>({
					text: `SELECT agent_id, definition_revision, content_hash
					       FROM module_agent_definitions`,
				});
			},
			{ access: 'read', tenantId: MODULE_AGENT_CATALOG_TENANT },
		);
		if (!stored) return normalized;
		const byAgent = new Map(stored.rows.map((row) => [row.agent_id, row]));
		for (const definition of normalized) {
			const previous = byAgent.get(definition.id);
			if (!previous) continue;
			const revision = Number(previous.definition_revision);
			if (definition.definitionRevision < revision) {
				throw new Error(
					`MODULE_AGENT_REVISION_DOWNGRADE: ${definition.id} registered revision ${definition.definitionRevision} after ${revision}.`,
				);
			}
			if (
				definition.definitionRevision === revision &&
				moduleAgentDefinitionHash(definition) !== previous.content_hash
			) {
				throw new Error(
					`MODULE_AGENT_REVISION_DRIFT: ${definition.id} changed without a definition revision bump.`,
				);
			}
		}
		return normalized;
	} finally {
		await lease.release();
	}
}
