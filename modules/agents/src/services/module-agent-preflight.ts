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
		purpose: 'migration',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [
				DATABASE_CAPABILITY_IDS.TRANSACTIONS,
				DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
			],
		},
	});
	try {
		/* A first run has no catalog table yet, and that is not a downgrade. */
		if (!(await lease.database.schema.hasTable('module_agent_definitions'))) {
			return normalized;
		}
		const stored = await lease.database.transaction(
			(transaction) =>
				transaction.query<StoredModuleAgentDefinition & { agent_id: string }>({
					text: `SELECT agent_id, definition_revision, content_hash
					       FROM module_agent_definitions`,
				}),
			{ access: 'read' },
		);
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
