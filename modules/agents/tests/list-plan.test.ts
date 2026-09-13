import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseProvider,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	agentPageStatement,
	migrateAgentsDatabase,
	runPageStatement,
} from '../src/services/database-repository.ts';

const TENANT = 'tenant-plan';
/* Enough rows that sorting the workspace is the expensive plan, and enough
   for the planner to have statistics it can act on. */
const ROWS = 5000;

let provider: DatabaseProvider;
let migration: DatabaseAdapterLease;
let runtime: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	migration = await provider.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [
				DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
				DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
				DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
			],
		},
	});
	await migrateAgentsDatabase(migration.database);
	runtime = await provider.acquire({
		namespace: 'agents.core',
		purpose: 'test',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
		},
	});
	await runtime.database.transaction(
		async (transaction) => {
			await transaction.execute({
				text: `INSERT INTO agent_definitions
				       (id, tenant_id, agent_key, name, description, instructions,
				        provider, model, allowed_tools_json, max_steps, timeout_ms,
				        temperature_milli, status, revision, created_by, created_at,
				        updated_by, updated_at)
				       SELECT 'agent-' || g, $1, 'key-' || g, 'Agent ' || g, 'Plan.',
				              'Answer briefly.', 'local-simulation', 'deterministic-v1',
				              '[]', 2, 5000, 0, 'active', 1, 'owner', g, 'owner', g
				       FROM generate_series(1, $2) AS g`,
				parameters: [TENANT, ROWS],
			});
			await transaction.execute({
				text: `INSERT INTO agent_runs
				       (id, tenant_id, agent_id, agent_name, agent_revision,
				        instructions_snapshot, provider, model, allowed_tools_json,
				        max_steps, timeout_ms, temperature_milli, trigger, status, input,
				        requested_by, permission_snapshot_json, tool_grants_json, attempt,
				        queued_at)
				       SELECT 'run-' || g, $1, 'agent-1', 'Agent 1', 1, 'Answer briefly.',
				              'local-simulation', 'deterministic-v1', '[]', 2, 5000, 0,
				              'service', 'queued', 'Run ' || g, 'owner', '[]', '[]', 0, g
				       FROM generate_series(1, $2) AS g`,
				parameters: [TENANT, ROWS],
			});
			await transaction.execute({
				text: `INSERT INTO agent_run_actors (run_id, tenant_id, actor_json)
				       SELECT id, tenant_id,
				              '{"kind":"user","id":"owner","label":"owner"}'
				       FROM agent_runs`,
			});
		},
		{ access: 'write', tenantId: TENANT },
	);
	/* The planner acts on statistics, and nothing has collected any yet.
	   ANALYZE is maintenance, so it runs on the migration lease. */
	await migration.database.execute({
		text: 'ANALYZE agent_definitions, agent_runs, agent_run_actors',
	});
});

afterAll(async () => {
	await runtime?.release();
	await migration?.release();
	await provider?.dispose();
});

/* The plan on the connection the repository runs on: the runtime role, under
   the forced row security of the tables. The repository exports the statement
   builders, so an ordering that drifts from its index is what this explains. */
async function plan(
	text: string,
	parameters: readonly (string | number | null)[],
): Promise<string> {
	const explained = await runtime.database.transaction(
		(transaction) =>
			transaction.query<{ 'QUERY PLAN': string }>({
				text: 'EXPLAIN ' + text,
				parameters: parameters as never,
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
}

describe('agents list page plans', () => {
	it('walks the queue order index for a runs page instead of sorting the workspace', async () => {
		const base = {
			direction: 'desc' as const,
			status: null,
			agentId: null,
			trigger: null,
			search: null,
			limit: 50,
		};
		const first = await plan(runPageStatement({ ...base, after: null }), [
			TENANT,
			null,
			null,
			null,
			null,
			null,
			50,
		]);
		expect(first).toContain('agent_runs_tenant_queue_order_idx');
		expect(first).not.toContain('Sort');

		const continued = await plan(
			runPageStatement({ ...base, after: { queuedAt: 2500, id: 'run-2500' } }),
			[TENANT, null, null, null, null, null, 2500, 'run-2500', 50],
		);
		expect(continued).toContain('agent_runs_tenant_queue_order_idx');
		expect(continued).not.toContain('Sort');

		const oldestFirst = await plan(
			runPageStatement({ ...base, direction: 'asc', after: null }),
			[TENANT, null, null, null, null, null, 50],
		);
		expect(oldestFirst).toContain('agent_runs_tenant_queue_order_idx');
		expect(oldestFirst).not.toContain('Sort');
	});

	it('walks the collation key index for a definitions page', async () => {
		const base = {
			sort: 'name' as const,
			direction: 'asc' as const,
			search: null,
			limit: 50,
		};
		const first = await plan(agentPageStatement({ ...base, after: null }), [
			TENANT,
			null,
			50,
		]);
		expect(first).toContain('agent_definitions_tenant_name_key_idx');
		expect(first).not.toContain('Sort');

		const continued = await plan(
			agentPageStatement({
				...base,
				after: { sortValue: 'agent 2500', id: 'agent-2500' },
			}),
			[TENANT, null, 'agent 2500', 'agent-2500', 50],
		);
		expect(continued).toContain('agent_definitions_tenant_name_key_idx');
		expect(continued).not.toContain('Sort');

		const newest = await plan(
			agentPageStatement({
				...base,
				sort: 'updatedAt',
				direction: 'desc',
				after: null,
			}),
			[TENANT, null, 50],
		);
		expect(newest).toContain('agent_definitions_tenant_updated_idx');
		expect(newest).not.toContain('Sort');
	});
});
