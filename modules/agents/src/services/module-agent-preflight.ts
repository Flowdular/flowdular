import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ModuleAgentDefinition } from '../domain/types.ts';
import {
	moduleAgentDefinitionHash,
	normalizeModuleAgentDefinitions,
} from '../server/define-agent.ts';

interface StoredModuleAgentDefinition {
	readonly definition_revision: number;
	readonly content_hash: string;
}

/* Validate persisted revision high-water marks before HMR retires the healthy
	 generation. This connection is deliberately read-only: migrations,
	 reconciliation, vault access, workers and timers still begin only after the
	 old generation has released its resources. */
export function preflightModuleAgentDefinitions(
	databasePath: string,
	definitions: readonly ModuleAgentDefinition[],
): readonly ModuleAgentDefinition[] {
	const normalized = normalizeModuleAgentDefinitions(definitions);
	if (databasePath === ':memory:' || !existsSync(databasePath))
		return normalized;

	const database = new DatabaseSync(databasePath, {
		readOnly: true,
		timeout: 5_000,
	});
	try {
		const table = database
			.prepare(
				`SELECT 1 AS present FROM sqlite_master
				 WHERE type = 'table' AND name = 'module_agent_definitions'`,
			)
			.get();
		if (!table) return normalized;

		const storedDefinition = database.prepare(
			`SELECT definition_revision, content_hash
			 FROM module_agent_definitions WHERE agent_id = ?`,
		);
		for (const definition of normalized) {
			const stored = storedDefinition.get(definition.id) as
				| StoredModuleAgentDefinition
				| undefined;
			if (!stored) continue;
			if (definition.definitionRevision < stored.definition_revision) {
				throw new Error(
					`MODULE_AGENT_REVISION_DOWNGRADE: ${definition.id} registered revision ${definition.definitionRevision} after ${stored.definition_revision}.`,
				);
			}
			if (
				definition.definitionRevision === stored.definition_revision &&
				moduleAgentDefinitionHash(definition) !== stored.content_hash
			) {
				throw new Error(
					`MODULE_AGENT_REVISION_DRIFT: ${definition.id} changed without a definition revision bump.`,
				);
			}
		}
		return normalized;
	} finally {
		database.close();
	}
}
