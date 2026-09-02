import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MIGRATION_LEDGER_TABLE,
	moduleMigrationStatus,
	runModuleMigrations,
} from '@coreloom/kernel';
import {
	AGENTS_MIGRATION_009,
	AGENTS_MIGRATION_015,
	migrations,
} from '../src/services/migration.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

let workspace: string | undefined;

afterEach(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

function databasePath(): string {
	workspace = mkdtempSync(join(tmpdir(), 'coreloom-agents-'));
	return join(workspace, 'agents.db');
}

function states(path: string): readonly string[] {
	return moduleMigrationStatus(new DatabaseSync(path), migrations).map(
		(entry) => entry.state,
	);
}

function auditHash(value: {
	readonly sequence: number;
	readonly action: string;
	readonly subjectType: string;
	readonly previousHash: string | null;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				'tenant-a',
				value.sequence,
				'account-a',
				value.action,
				value.subjectType,
				`subject-${value.sequence}`,
				'{}',
				value.sequence * 1_000,
				value.previousHash,
			]),
		)
		.digest('hex');
}

function insertAudit(
	db: DatabaseSync,
	value: {
		readonly table: string;
		readonly sequence: number;
		readonly action: string;
		readonly subjectType: string;
		readonly previousHash: string | null;
	},
): string {
	const hash = auditHash(value);
	db.prepare(
		`INSERT INTO ${value.table}
		 (id, tenant_id, sequence, actor_id, action, subject_type, subject_id,
		  metadata_json, occurred_at, previous_hash, event_hash)
		 VALUES (?, 'tenant-a', ?, 'account-a', ?, ?, ?, '{}', ?, ?, ?)`,
	).run(
		`event-${value.sequence}`,
		value.sequence,
		value.action,
		value.subjectType,
		`subject-${value.sequence}`,
		value.sequence * 1_000,
		value.previousHash,
		hash,
	);
	return hash;
}

describe('agents migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		const files = readdirSync(directory)
			.filter((name) => name.endsWith('.up.sql'))
			.sort();

		expect(migrations.map((migration) => `${migration.id}.up.sql`)).toEqual(
			files,
		);
		for (const migration of migrations) {
			expect(migration.statements).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies every migration on a fresh database', () => {
		const path = databasePath();

		new SqliteAgentRepository(path);

		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts a database that already carries the schema and rows', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		before.exec('PRAGMA foreign_keys = ON');
		for (const migration of migrations) before.exec(migration.statements);
		before.exec(`INSERT INTO agent_definitions
	 (id, tenant_id, agent_key, name, description, instructions, provider, model,
	  allowed_tools_json, max_steps, timeout_ms, temperature_milli, status,
	  revision, created_by, created_at, updated_by, updated_at)
	 VALUES ('agent-1', 'tenant-a', 'assistant', 'Assistant', 'Test agent',
	  'Help the user', 'local-simulation', 'deterministic-v1', '[]', 4, 10000,
	  0, 'active', 1, 'owner-a', 1, 'owner-a', 1)`);
		before.close();

		expect(states(path)).toEqual(migrations.map(() => 'adopted'));
		const repository = new SqliteAgentRepository(path);
		expect(repository.getAgentRevision('tenant-a', 'agent-1', 1)).toMatchObject(
			{
				name: 'Assistant',
				revision: 1,
				instructions: 'Help the user',
			},
		);
		repository.close();

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id`)
				.all(),
		).toEqual(
			migrations
				.map((migration) => ({ id: migration.id }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
		expect(after.prepare('SELECT name FROM agent_definitions').all()).toEqual([
			{ name: 'Assistant' },
		]);
		expect(() =>
			after
				.prepare(
					`UPDATE agent_definition_revisions SET name = 'Changed'
					 WHERE tenant_id = 'tenant-a' AND agent_id = 'agent-1' AND revision = 1`,
				)
				.run(),
		).toThrow('agent definition revisions are immutable');
		after.close();
	});

	it('runs clean on a second repository construction', () => {
		const path = databasePath();
		new SqliteAgentRepository(path);

		expect(() => new SqliteAgentRepository(path)).not.toThrow();
		expect(states(path)).toEqual(migrations.map(() => 'applied'));
	});

	it('adopts the exact legacy v3 audit projection and preserves its full chain in v4', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		const preWorkflow = migrations.filter(
			(migration) =>
				![
					'0009_agent_audit_v3',
					'0013_workflow_prerequisites',
					'0014_agent_action_audit',
					'0017_agent_authorization_subjects',
				].includes(migration.id),
		);
		runModuleMigrations(before, preWorkflow);
		const first = insertAudit(before, {
			table: 'agent_audit_events_v2',
			sequence: 1,
			action: 'agent.updated',
			subjectType: 'agent',
			previousHash: null,
		});
		before.exec(AGENTS_MIGRATION_009);
		const second = insertAudit(before, {
			table: 'agent_audit_events_v3',
			sequence: 2,
			action: 'agent-schedule.created',
			subjectType: 'agent-schedule',
			previousHash: first,
		});
		insertAudit(before, {
			table: 'agent_audit_events_v3',
			sequence: 3,
			action: 'agent-trigger.created',
			subjectType: 'agent-trigger',
			previousHash: second,
		});
		const expected = before
			.prepare('SELECT * FROM agent_audit_events_v3 ORDER BY sequence')
			.all();
		before.close();

		expect(states(path)).toContain('adopted');
		const repository = new SqliteAgentRepository(path);
		expect(repository.verifyAuditChain('tenant-a')).toBe(true);
		repository.close();

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare('SELECT * FROM agent_audit_events_v4 ORDER BY sequence')
				.all(),
		).toEqual(expected);
		expect(
			after
				.prepare(
					"SELECT sql FROM sqlite_master WHERE name = 'agent_audit_events_v4'",
				)
				.get(),
		).toMatchObject({
			sql: expect.stringContaining("'agent-action'"),
		});
		expect(
			after
				.prepare(
					`SELECT id FROM ${MIGRATION_LEDGER_TABLE} WHERE id IN (?, ?, ?) ORDER BY id`,
				)
				.all(
					'0009_agent_audit_v3',
					'0013_workflow_prerequisites',
					'0014_agent_action_audit',
				),
		).toEqual([
			{ id: '0009_agent_audit_v3' },
			{ id: '0013_workflow_prerequisites' },
			{ id: '0014_agent_action_audit' },
		]);
		after.close();
	});

	it('refuses an incompatible pre-ledger v3 audit table', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		const preAudit = migrations.filter((migration) =>
			[
				'0001_agents_core',
				'0002_provider_connections',
				'0003_resource_audit',
				'0004_run_grants',
				'0005_long_running_limits',
				'0006_agent_skills',
				'0007_model_readiness',
				'0008_output_limits',
			].includes(migration.id),
		);
		runModuleMigrations(before, preAudit);
		before.exec(
			AGENTS_MIGRATION_009.replace(
				"'agent-schedule', 'agent-trigger'",
				"'agent-action'",
			),
		);
		before.close();

		expect(() => new SqliteAgentRepository(path)).toThrowError(
			/incompatible pre-ledger audit projection/,
		);
		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} WHERE id = ?`)
				.get('0009_agent_audit_v3'),
		).toBeUndefined();
		after.close();
	});

	it('backfills a legacy run requester as a user actor without inventing provenance', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		runModuleMigrations(
			before,
			migrations.filter(
				(migration) =>
					![
						'0013_workflow_prerequisites',
						'0014_agent_action_audit',
						'0015_agent_run_actors',
						'0017_agent_authorization_subjects',
					].includes(migration.id),
			),
		);
		before.exec(`INSERT INTO agent_definitions
		 (id, tenant_id, agent_key, name, description, instructions, provider, model,
		  allowed_tools_json, max_steps, timeout_ms, temperature_milli, status,
		  revision, created_by, created_at, updated_by, updated_at)
		 VALUES ('agent-legacy', 'tenant-a', 'legacy', 'Legacy', 'Legacy agent',
		  'Help', 'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0,
		  'active', 1, 'owner-a', 1, 'owner-a', 1);
		 INSERT INTO agent_runs
		 (id, tenant_id, agent_id, agent_name, agent_revision,
		  instructions_snapshot, provider, model, allowed_tools_json, max_steps,
		  timeout_ms, temperature_milli, trigger, status, input, output,
		  requested_by, permission_snapshot_json, tool_grants_json, usage_json,
		  failure_code, failure_message, idempotency_key, attempt, queued_at,
		  started_at, completed_at, lease_owner, lease_expires_at)
		 VALUES ('run-legacy', 'tenant-a', 'agent-legacy', 'Legacy', 1, 'Help',
		  'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0, 'schedule',
		  'succeeded', 'Run', 'Done', 'schedule:legacy', '[]', '[]',
		  '{"inputTokens":1,"outputTokens":1,"totalTokens":2}', NULL, NULL,
		  'legacy-run-key', 1, 1, 2, 3, NULL, NULL);`);
		before.close();

		const repository = new SqliteAgentRepository(path);
		expect(repository.getRun('tenant-a', 'run-legacy')?.requestedActor).toEqual(
			{
				kind: 'user',
				id: 'schedule:legacy',
				label: 'schedule:legacy',
			},
		);
		repository.close();
	});

	it('finishes an exact but incomplete pre-ledger actor backfill instead of adopting it', () => {
		const path = databasePath();
		const before = new DatabaseSync(path);
		runModuleMigrations(
			before,
			migrations.filter(
				(migration) =>
					![
						'0015_agent_run_actors',
						'0017_agent_authorization_subjects',
					].includes(migration.id),
			),
		);
		before.exec(`INSERT INTO agent_definitions
		 (id, tenant_id, agent_key, name, description, instructions, provider, model,
		  allowed_tools_json, max_steps, timeout_ms, temperature_milli, status,
		  revision, created_by, created_at, updated_by, updated_at)
		 VALUES ('agent-legacy', 'tenant-a', 'legacy', 'Legacy', 'Legacy agent',
		  'Help', 'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0,
		  'active', 1, 'owner-a', 1, 'owner-a', 1);
		 INSERT INTO agent_runs
		 (id, tenant_id, agent_id, agent_name, agent_revision,
		  instructions_snapshot, provider, model, allowed_tools_json, max_steps,
		  timeout_ms, temperature_milli, trigger, status, input, output,
		  requested_by, permission_snapshot_json, tool_grants_json, usage_json,
		  failure_code, failure_message, idempotency_key, attempt, queued_at,
		  started_at, completed_at, lease_owner, lease_expires_at)
		 VALUES
		 ('run-one', 'tenant-a', 'agent-legacy', 'Legacy', 1, 'Help',
		  'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0, 'service',
		  'queued', 'One', NULL, 'owner-a', '[]', '[]', NULL, NULL, NULL,
		  'legacy-key-one', 0, 1, NULL, NULL, NULL, NULL),
		 ('run-two', 'tenant-a', 'agent-legacy', 'Legacy', 1, 'Help',
		  'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0, 'service',
		  'queued', 'Two', NULL, 'owner-b', '[]', '[]', NULL, NULL, NULL,
		  'legacy-key-two', 0, 2, NULL, NULL, NULL, NULL);`);
		before.exec(AGENTS_MIGRATION_015);
		before.exec("DELETE FROM agent_run_actors WHERE run_id = 'run-two'");
		before.close();

		const repository = new SqliteAgentRepository(path);
		expect(repository.getRun('tenant-a', 'run-one')?.requestedActor.id).toBe(
			'owner-a',
		);
		expect(repository.getRun('tenant-a', 'run-two')?.requestedActor.id).toBe(
			'owner-b',
		);
		repository.close();

		const after = new DatabaseSync(path);
		expect(
			after
				.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} WHERE id = ?`)
				.get('0015_agent_run_actors'),
		).toEqual({ id: '0015_agent_run_actors' });
		expect(
			after.prepare('SELECT count(*) AS count FROM agent_run_actors').get(),
		).toEqual({ count: 2 });
		after.close();
	});

	it('refuses a pre-ledger actor row whose authority does not match its run', () => {
		const path = databasePath();
		const repository = new SqliteAgentRepository(path);
		const db = new DatabaseSync(path);
		db.exec(`DELETE FROM ${MIGRATION_LEDGER_TABLE}
		 WHERE id = '0015_agent_run_actors';`);
		repository.close();
		db.exec(`INSERT INTO agent_definitions
		 (id, tenant_id, agent_key, name, description, instructions, provider, model,
		  allowed_tools_json, max_steps, timeout_ms, temperature_milli, status,
		  revision, created_by, created_at, updated_by, updated_at)
		 VALUES ('agent-invalid', 'tenant-a', 'invalid', 'Invalid', 'Invalid actor',
		  'Help', 'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0,
		  'active', 1, 'owner-a', 1, 'owner-a', 1);
		 INSERT INTO agent_runs
		 (id, tenant_id, agent_id, agent_name, agent_revision,
		  instructions_snapshot, provider, model, allowed_tools_json, max_steps,
		  timeout_ms, temperature_milli, trigger, status, input, output,
		  requested_by, permission_snapshot_json, tool_grants_json, usage_json,
		  failure_code, failure_message, idempotency_key, attempt, queued_at,
		  started_at, completed_at, lease_owner, lease_expires_at)
		 VALUES ('run-invalid', 'tenant-a', 'agent-invalid', 'Invalid', 1, 'Help',
		  'local-simulation', 'deterministic-v1', '[]', 4, 10000, 0, 'service',
		  'queued', 'Run', NULL, 'owner-a', '[]', '[]', NULL, NULL, NULL,
		  'invalid-key', 0, 1, NULL, NULL, NULL, NULL);
		 INSERT INTO agent_run_contracts
		 (run_id, tenant_id, workflow_run_id, output_contract_json,
		  structured_output_json, request_hash)
		 VALUES ('run-invalid', 'tenant-a', NULL, '{"kind":"text"}', NULL, 'hash');
		 INSERT INTO agent_run_actors (run_id, tenant_id, actor_json)
		 VALUES ('run-invalid', 'tenant-a',
		  '{"kind":"user","id":"another-owner","label":"Another"}');`);
		db.close();

		expect(() => new SqliteAgentRepository(path)).toThrowError(
			/invalid pre-ledger actor row/,
		);
	});
});
