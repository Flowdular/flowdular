import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentExecutionResult,
	AgentUsage,
} from '@coreloom/harness';
import type {
	AgentAuditEvent,
	AgentDefinition,
	AgentSkill,
	AgentSkillSnapshot,
	AgentRun,
	AgentRunDetail,
	AgentRunExecution,
} from '../domain/types.ts';
import {
	AGENTS_MIGRATION_001,
	AGENTS_MIGRATION_002,
	AGENTS_MIGRATION_003,
	AGENTS_MIGRATION_004,
	AGENTS_MIGRATION_005,
	AGENTS_MIGRATION_006,
	AGENTS_MIGRATION_007,
	AGENTS_MIGRATION_008,
} from './migration.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentSkillKeyError,
	DuplicateRunIdempotencyKeyError,
	type AgentRepository,
	type RecoverableRun,
} from './repository.ts';

interface AgentRow {
	id: string;
	tenant_id: string;
	agent_key: string;
	name: string;
	description: string;
	instructions: string;
	provider: string;
	model: string;
	allowed_tools_json: string;
	max_steps: number;
	timeout_ms: number;
	temperature_milli: number;
	max_output_tokens: number;
	status: AgentDefinition['status'];
	revision: number;
	created_by: string;
	created_at: number;
	updated_by: string;
	updated_at: number;
}

interface RunRow {
	id: string;
	tenant_id: string;
	agent_id: string;
	agent_name: string;
	agent_revision: number;
	instructions_snapshot: string;
	provider: string;
	model: string;
	allowed_tools_json: string;
	max_steps: number;
	timeout_ms: number;
	temperature_milli: number;
	max_output_tokens: number;
	trigger: AgentRun['trigger'];
	status: AgentRun['status'];
	input: string;
	output: string | null;
	requested_by: string;
	permission_snapshot_json: string;
	tool_grants_json: string;
	usage_json: string | null;
	failure_code: string | null;
	failure_message: string | null;
	attempt: number;
	queued_at: number;
	started_at: number | null;
	completed_at: number | null;
	lease_expires_at: number | null;
}

interface RunEventRow {
	sequence: number;
	event_type: AgentExecutionEvent['type'];
	message: string;
	metadata_json: string;
	occurred_at: number;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number;
	actor_id: string;
	action: string;
	subject_type: AgentAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number;
	previous_hash: string | null;
	event_hash: string;
}

interface RecoverableRow {
	tenant_id: string;
	id: string;
}

interface SkillRow {
	id: string;
	tenant_id: string;
	skill_key: string;
	name: string;
	description: string;
	instructions: string;
	required_tools_json: string;
	status: AgentSkill['status'];
	revision: number;
	created_by: string;
	created_at: number;
	updated_by: string;
	updated_at: number;
}

interface SkillSnapshotRow {
	skill_id: string;
	skill_key: string;
	skill_name: string;
	skill_revision: number;
	required_tools_json: string;
}

function stringArray(value: string): readonly string[] {
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.some((item) => typeof item !== 'string')
	) {
		throw new Error('Stored string array is invalid.');
	}
	return parsed as string[];
}

function usage(value: string | null): AgentUsage | null {
	return value === null ? null : (JSON.parse(value) as AgentUsage);
}

function metadata(
	value: string,
): Readonly<Record<string, string | number | boolean>> {
	return JSON.parse(value) as Record<string, string | number | boolean>;
}

function stableMetadata(
	value: Readonly<Record<string, string | number | boolean>>,
): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(value).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
}

function fromAgentRow(row: AgentRow): AgentDefinition {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.agent_key,
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		provider: row.provider,
		model: row.model,
		allowedTools: stringArray(row.allowed_tools_json),
		skillIds: [],
		maxSteps: row.max_steps,
		timeoutMs: row.timeout_ms,
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: row.max_output_tokens,
		status: row.status,
		revision: row.revision,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at,
	};
}

function fromRunRow(row: RunRow): AgentRun {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		agentId: row.agent_id,
		agentName: row.agent_name,
		agentRevision: row.agent_revision,
		trigger: row.trigger,
		status: row.status,
		input: row.input,
		output: row.output,
		provider: row.provider,
		model: row.model,
		requestedBy: row.requested_by,
		permissionSnapshot: stringArray(row.permission_snapshot_json),
		toolGrants: stringArray(row.tool_grants_json),
		skillSnapshots: [],
		usage: usage(row.usage_json),
		failureCode: row.failure_code,
		failureMessage: row.failure_message,
		attempt: row.attempt,
		queuedAt: row.queued_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		leaseExpiresAt: row.lease_expires_at,
	};
}

function fromSkillRow(row: SkillRow): AgentSkill {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.skill_key,
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		requiredTools: stringArray(row.required_tools_json),
		status: row.status,
		revision: row.revision,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at,
	};
}

function executionFromRow(row: RunRow): AgentRunExecution {
	const definition: AgentExecutionDefinition = {
		id: row.agent_id,
		name: row.agent_name,
		revision: row.agent_revision,
		instructions: row.instructions_snapshot,
		provider: row.provider,
		model: row.model,
		allowedTools: stringArray(row.allowed_tools_json),
		maxSteps: row.max_steps,
		timeoutMs: row.timeout_ms,
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: row.max_output_tokens,
	};
	return { run: fromRunRow(row), definition };
}

function fromAuditRow(row: AuditRow): AgentAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: row.sequence,
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: metadata(row.metadata_json),
		occurredAt: row.occurred_at,
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
	};
}

function auditHash(value: {
	tenantId: string;
	sequence: number;
	actorId: string;
	action: string;
	subjectType: AgentAuditEvent['subjectType'];
	subjectId: string;
	metadataJson: string;
	occurredAt: number;
	previousHash: string | null;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				value.tenantId,
				value.sequence,
				value.actorId,
				value.action,
				value.subjectType,
				value.subjectId,
				value.metadataJson,
				value.occurredAt,
				value.previousHash,
			]),
		)
		.digest('hex');
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

const RUN_COLUMNS = `agent_runs.id, tenant_id, agent_id, agent_name, agent_revision,
 instructions_snapshot, provider, model, allowed_tools_json, max_steps,
 COALESCE(agent_run_execution_limits.timeout_ms, agent_runs.timeout_ms) AS timeout_ms,
 temperature_milli,
 COALESCE(agent_run_output_limits.max_output_tokens, ${DEFAULT_MAX_OUTPUT_TOKENS}) AS max_output_tokens,
 trigger, status, input, output, requested_by,
 permission_snapshot_json, tool_grants_json, usage_json, failure_code,
 failure_message, attempt, queued_at, started_at, completed_at, lease_expires_at`;
const RUN_FROM = `agent_runs LEFT JOIN agent_run_execution_limits
 ON agent_run_execution_limits.run_id = agent_runs.id
 LEFT JOIN agent_run_output_limits
 ON agent_run_output_limits.run_id = agent_runs.id`;
const AGENT_SELECT = `SELECT agent_definitions.*,
 COALESCE(agent_definition_execution_limits.timeout_ms,
 agent_definitions.timeout_ms) AS timeout_ms,
 COALESCE(agent_definition_output_limits.max_output_tokens,
 ${DEFAULT_MAX_OUTPUT_TOKENS}) AS max_output_tokens
 FROM agent_definitions LEFT JOIN agent_definition_execution_limits
 ON agent_definition_execution_limits.agent_id = agent_definitions.id
 LEFT JOIN agent_definition_output_limits
 ON agent_definition_output_limits.agent_id = agent_definitions.id`;

export class SqliteAgentRepository implements AgentRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5_000 });
		this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
		this.#database.exec(AGENTS_MIGRATION_001);
		this.#database.exec(AGENTS_MIGRATION_002);
		this.#database.exec(AGENTS_MIGRATION_003);
		this.#database.exec(AGENTS_MIGRATION_004);
		this.#database.exec(AGENTS_MIGRATION_005);
		this.#database.exec(AGENTS_MIGRATION_006);
		this.#database.exec(AGENTS_MIGRATION_007);
		this.#database.exec(AGENTS_MIGRATION_008);
	}

	#skillIds(tenantId: string, agentId: string): readonly string[] {
		return (
			this.#database
				.prepare(
					`SELECT skill_id FROM agent_skill_assignments
					 WHERE tenant_id = ? AND agent_id = ? ORDER BY skill_id`,
				)
				.all(tenantId, agentId) as unknown as { skill_id: string }[]
		).map((row) => row.skill_id);
	}

	#skillSnapshots(runId: string): readonly AgentSkillSnapshot[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM agent_run_skill_snapshots
					 WHERE run_id = ? ORDER BY skill_key, skill_id`,
				)
				.all(runId) as unknown as SkillSnapshotRow[]
		).map((row) => ({
			id: row.skill_id,
			key: row.skill_key,
			name: row.skill_name,
			revision: row.skill_revision,
			requiredTools: stringArray(row.required_tools_json),
		}));
	}

	#setAgentSkills(agent: AgentDefinition): void {
		this.#database
			.prepare('DELETE FROM agent_skill_assignments WHERE agent_id = ?')
			.run(agent.id);
		const insert = this.#database.prepare(
			`INSERT INTO agent_skill_assignments (agent_id, skill_id, tenant_id)
			 VALUES (?, ?, ?)`,
		);
		for (const skillId of agent.skillIds) {
			insert.run(agent.id, skillId, agent.tenantId);
		}
	}

	listAgents(tenantId: string): readonly AgentDefinition[] {
		return (
			this.#database
				.prepare(`${AGENT_SELECT} WHERE tenant_id = ? ORDER BY lower(name), id`)
				.all(tenantId) as unknown as AgentRow[]
		).map((row) => {
			const agent = fromAgentRow(row);
			return { ...agent, skillIds: this.#skillIds(agent.tenantId, agent.id) };
		});
	}

	getAgent(tenantId: string, agentId: string): AgentDefinition | null {
		const row = this.#database
			.prepare(
				`${AGENT_SELECT} WHERE tenant_id = ? AND agent_definitions.id = ?`,
			)
			.get(tenantId, agentId) as unknown as AgentRow | undefined;
		if (!row) return null;
		const agent = fromAgentRow(row);
		return { ...agent, skillIds: this.#skillIds(agent.tenantId, agent.id) };
	}

	createAgent(agent: AgentDefinition): AgentDefinition {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					`INSERT INTO agent_definitions
					 (id, tenant_id, agent_key, name, description, instructions,
					  provider, model, allowed_tools_json, max_steps, timeout_ms,
					  temperature_milli, status, revision, created_by, created_at,
					  updated_by, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					agent.id,
					agent.tenantId,
					agent.key,
					agent.name,
					agent.description,
					agent.instructions,
					agent.provider,
					agent.model,
					JSON.stringify(agent.allowedTools),
					agent.maxSteps,
					Math.min(agent.timeoutMs, 300_000),
					Math.round(agent.temperature * 1_000),
					agent.status,
					agent.revision,
					agent.createdBy,
					agent.createdAt,
					agent.updatedBy,
					agent.updatedAt,
				);
			this.#database
				.prepare(
					`INSERT INTO agent_definition_execution_limits (agent_id, timeout_ms)
					 VALUES (?, ?)`,
				)
				.run(agent.id, agent.timeoutMs);
			this.#database
				.prepare(
					`INSERT INTO agent_definition_output_limits (agent_id, max_output_tokens)
					 VALUES (?, ?)`,
				)
				.run(agent.id, agent.maxOutputTokens);
			this.#setAgentSkills(agent);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('agent_definitions.tenant_id')) {
				throw new DuplicateAgentKeyError();
			}
			throw error;
		}
		return agent;
	}

	updateAgent(agent: AgentDefinition): AgentDefinition {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const result = this.#database
				.prepare(
					`UPDATE agent_definitions SET agent_key = ?, name = ?,
					 description = ?, instructions = ?, provider = ?, model = ?,
					 allowed_tools_json = ?, max_steps = ?, timeout_ms = ?,
					 temperature_milli = ?, status = ?, revision = ?, updated_by = ?,
					 updated_at = ? WHERE tenant_id = ? AND id = ?`,
				)
				.run(
					agent.key,
					agent.name,
					agent.description,
					agent.instructions,
					agent.provider,
					agent.model,
					JSON.stringify(agent.allowedTools),
					agent.maxSteps,
					Math.min(agent.timeoutMs, 300_000),
					Math.round(agent.temperature * 1_000),
					agent.status,
					agent.revision,
					agent.updatedBy,
					agent.updatedAt,
					agent.tenantId,
					agent.id,
				);
			if (result.changes !== 1) throw new Error('Agent definition not found.');
			this.#database
				.prepare(
					`INSERT INTO agent_definition_execution_limits (agent_id, timeout_ms)
					 VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET timeout_ms = excluded.timeout_ms`,
				)
				.run(agent.id, agent.timeoutMs);
			this.#database
				.prepare(
					`INSERT INTO agent_definition_output_limits (agent_id, max_output_tokens)
					 VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET max_output_tokens = excluded.max_output_tokens`,
				)
				.run(agent.id, agent.maxOutputTokens);
			this.#setAgentSkills(agent);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('agent_definitions.tenant_id')) {
				throw new DuplicateAgentKeyError();
			}
			throw error;
		}
		return agent;
	}

	listSkills(tenantId: string): readonly AgentSkill[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM agent_skills WHERE tenant_id = ?
					 ORDER BY lower(name), id`,
				)
				.all(tenantId) as unknown as SkillRow[]
		).map(fromSkillRow);
	}

	getSkill(tenantId: string, skillId: string): AgentSkill | null {
		const row = this.#database
			.prepare('SELECT * FROM agent_skills WHERE tenant_id = ? AND id = ?')
			.get(tenantId, skillId) as unknown as SkillRow | undefined;
		return row ? fromSkillRow(row) : null;
	}

	createSkill(skill: AgentSkill): AgentSkill {
		try {
			this.#database
				.prepare(
					`INSERT INTO agent_skills
					 (id, tenant_id, skill_key, name, description, instructions,
					  required_tools_json, status, revision, created_by, created_at,
					  updated_by, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					skill.id,
					skill.tenantId,
					skill.key,
					skill.name,
					skill.description,
					skill.instructions,
					JSON.stringify(skill.requiredTools),
					skill.status,
					skill.revision,
					skill.createdBy,
					skill.createdAt,
					skill.updatedBy,
					skill.updatedAt,
				);
		} catch (error) {
			if (String(error).includes('agent_skills.tenant_id')) {
				throw new DuplicateAgentSkillKeyError();
			}
			throw error;
		}
		return skill;
	}

	updateSkill(skill: AgentSkill): AgentSkill {
		try {
			const result = this.#database
				.prepare(
					`UPDATE agent_skills SET skill_key = ?, name = ?, description = ?,
					 instructions = ?, required_tools_json = ?, status = ?, revision = ?,
					 updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
				)
				.run(
					skill.key,
					skill.name,
					skill.description,
					skill.instructions,
					JSON.stringify(skill.requiredTools),
					skill.status,
					skill.revision,
					skill.updatedBy,
					skill.updatedAt,
					skill.tenantId,
					skill.id,
				);
			if (result.changes !== 1) throw new Error('Agent skill not found.');
		} catch (error) {
			if (String(error).includes('agent_skills.tenant_id')) {
				throw new DuplicateAgentSkillKeyError();
			}
			throw error;
		}
		return skill;
	}

	listRuns(tenantId: string, limit: number): readonly AgentRun[] {
		return (
			this.#database
				.prepare(
					`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE tenant_id = ?
					 ORDER BY queued_at DESC, id DESC LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as RunRow[]
		).map((row) => {
			const run = fromRunRow(row);
			return { ...run, skillSnapshots: this.#skillSnapshots(run.id) };
		});
	}

	getRun(tenantId: string, runId: string): AgentRunDetail | null {
		const row = this.#database
			.prepare(
				`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE tenant_id = ? AND agent_runs.id = ?`,
			)
			.get(tenantId, runId) as unknown as RunRow | undefined;
		if (!row) return null;
		const events = (
			this.#database
				.prepare(
					`SELECT sequence, event_type, message, metadata_json, occurred_at
					 FROM agent_run_events WHERE tenant_id = ? AND run_id = ?
					 ORDER BY sequence`,
				)
				.all(tenantId, runId) as unknown as RunEventRow[]
		).map(
			(event): AgentExecutionEvent => ({
				sequence: event.sequence,
				type: event.event_type,
				timestamp: event.occurred_at,
				message: event.message,
				metadata: metadata(event.metadata_json),
			}),
		);
		return {
			...fromRunRow(row),
			skillSnapshots: this.#skillSnapshots(row.id),
			events,
		};
	}

	findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentRun | null {
		const row = this.#database
			.prepare(
				`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM}
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, idempotencyKey) as unknown as RunRow | undefined;
		if (!row) return null;
		const run = fromRunRow(row);
		return { ...run, skillSnapshots: this.#skillSnapshots(run.id) };
	}

	enqueueRun(
		execution: AgentRunExecution,
		idempotencyKey: string | null,
	): AgentRun {
		const { run, definition } = execution;
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					`INSERT INTO agent_runs
				 (id, tenant_id, agent_id, agent_name, agent_revision,
				  instructions_snapshot, provider, model, allowed_tools_json,
				  max_steps, timeout_ms, temperature_milli, trigger, status, input,
				  output, requested_by, permission_snapshot_json, tool_grants_json,
				  usage_json, failure_code, failure_message, idempotency_key, attempt,
				  queued_at, started_at, completed_at, lease_owner, lease_expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL,
				  ?, ?, ?, NULL, NULL, NULL, ?, 0, ?, NULL, NULL, NULL, NULL)`,
				)
				.run(
					run.id,
					run.tenantId,
					run.agentId,
					run.agentName,
					run.agentRevision,
					definition.instructions,
					run.provider,
					run.model,
					JSON.stringify(definition.allowedTools),
					definition.maxSteps,
					Math.min(definition.timeoutMs, 300_000),
					Math.round(definition.temperature * 1_000),
					run.trigger,
					run.input,
					run.requestedBy,
					JSON.stringify(run.permissionSnapshot),
					JSON.stringify(run.toolGrants),
					idempotencyKey,
					run.queuedAt,
				);
			this.#database
				.prepare(
					`INSERT INTO agent_run_execution_limits (run_id, timeout_ms) VALUES (?, ?)`,
				)
				.run(run.id, definition.timeoutMs);
			this.#database
				.prepare(
					`INSERT INTO agent_run_output_limits (run_id, max_output_tokens) VALUES (?, ?)`,
				)
				.run(run.id, definition.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
			const insertSkill = this.#database.prepare(
				`INSERT INTO agent_run_skill_snapshots
			 (run_id, skill_id, skill_key, skill_name, skill_revision, required_tools_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const skill of run.skillSnapshots) {
				insertSkill.run(
					run.id,
					skill.id,
					skill.key,
					skill.name,
					skill.revision,
					JSON.stringify(skill.requiredTools),
				);
			}
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('agent_runs.idempotency_key')) {
				throw new DuplicateRunIdempotencyKeyError();
			}
			throw error;
		}
		return run;
	}

	listRecoverableRuns(now: number, limit: number): readonly RecoverableRun[] {
		return (
			this.#database
				.prepare(
					`SELECT tenant_id, id FROM agent_runs
					 WHERE status = 'queued'
					    OR (status = 'running' AND lease_expires_at < ?)
					 ORDER BY queued_at, id LIMIT ?`,
				)
				.all(now, limit) as unknown as RecoverableRow[]
		).map((row) => ({ tenantId: row.tenant_id, runId: row.id }));
	}

	claimRun(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
	): AgentRunExecution | null {
		const result = this.#database
			.prepare(
				`UPDATE agent_runs SET status = 'running', lease_owner = ?,
				 lease_expires_at = ?, started_at = COALESCE(started_at, ?),
				 attempt = attempt + 1
				 WHERE tenant_id = ? AND id = ? AND
				 (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))`,
			)
			.run(workerId, leaseExpiresAt, now, tenantId, runId, now);
		if (result.changes !== 1) return null;
		const row = this.#database
			.prepare(
				`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE tenant_id = ? AND agent_runs.id = ?`,
			)
			.get(tenantId, runId) as unknown as RunRow;
		const execution = executionFromRow(row);
		return {
			...execution,
			run: {
				...execution.run,
				skillSnapshots: this.#skillSnapshots(execution.run.id),
			},
		};
	}

	renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE agent_runs SET lease_expires_at = ? WHERE tenant_id = ?
					 AND id = ? AND status = 'running' AND lease_owner = ?`,
				)
				.run(leaseExpiresAt, tenantId, runId, workerId).changes === 1
		);
	}

	consumeRunGrant(input: {
		readonly grantId: string;
		readonly tokenHash: string;
		readonly tenantId: string;
		readonly runId: string;
		readonly workerId: string;
		readonly providerId: string;
		readonly modelId: string;
		readonly issuedAt: number;
		readonly expiresAt: number;
		readonly consumedAt: number;
	}): boolean {
		this.#database
			.prepare('DELETE FROM agent_run_grant_uses WHERE expires_at < ?')
			.run(input.consumedAt);
		const result = this.#database
			.prepare(
				`INSERT OR IGNORE INTO agent_run_grant_uses
				 (grant_id, token_hash, tenant_id, run_id, worker_id, provider_id,
				  model_id, issued_at, expires_at, consumed_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 FROM agent_runs
				 WHERE tenant_id = ? AND id = ? AND status = 'running'
				   AND lease_owner = ? AND lease_expires_at >= ?`,
			)
			.run(
				input.grantId,
				input.tokenHash,
				input.tenantId,
				input.runId,
				input.workerId,
				input.providerId,
				input.modelId,
				input.issuedAt,
				input.expiresAt,
				input.consumedAt,
				input.tenantId,
				input.runId,
				input.workerId,
				input.consumedAt,
			);
		return result.changes === 1;
	}

	appendRunEvent(
		tenantId: string,
		runId: string,
		event: AgentExecutionEvent,
	): void {
		this.#database
			.prepare(
				`INSERT INTO agent_run_events
				 (run_id, tenant_id, sequence, event_type, message, metadata_json,
				  occurred_at)
				 SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
				 FROM agent_run_events WHERE run_id = ? AND tenant_id = ?`,
			)
			.run(
				runId,
				tenantId,
				event.type,
				event.message,
				stableMetadata(event.metadata ?? {}),
				event.timestamp,
				runId,
				tenantId,
			);
	}

	completeRun(
		tenantId: string,
		runId: string,
		workerId: string,
		result: AgentExecutionResult,
	): void {
		const update = this.#database
			.prepare(
				`UPDATE agent_runs SET status = 'succeeded', output = ?, usage_json = ?,
				 completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
				 WHERE tenant_id = ? AND id = ? AND status = 'running'
				 AND lease_owner = ?`,
			)
			.run(
				result.output,
				JSON.stringify(result.usage),
				result.completedAt,
				tenantId,
				runId,
				workerId,
			);
		if (update.changes !== 1) throw new Error('Agent run lease was lost.');
	}

	failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
	): void {
		const update = this.#database
			.prepare(
				`UPDATE agent_runs SET status = 'failed', failure_code = ?,
				 failure_message = ?, completed_at = ?, lease_owner = NULL,
				 lease_expires_at = NULL WHERE tenant_id = ? AND id = ?
				 AND status = 'running' AND lease_owner = ?`,
			)
			.run(code, message, completedAt, tenantId, runId, workerId);
		if (update.changes !== 1) throw new Error('Agent run lease was lost.');
	}

	cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
	): AgentRun['status'] | null {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const current = this.#database
				.prepare('SELECT status FROM agent_runs WHERE tenant_id = ? AND id = ?')
				.get(tenantId, runId) as unknown as
				| { status: AgentRun['status'] }
				| undefined;
			if (!current || !['queued', 'running'].includes(current.status)) {
				this.#database.exec('COMMIT');
				return null;
			}
			this.#database
				.prepare(
					`UPDATE agent_runs SET status = 'cancelled', failure_code = 'RUN_CANCELLED',
					 failure_message = ?, completed_at = ?, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = ? AND id = ?`,
				)
				.run(message, completedAt, tenantId, runId);
			this.#database.exec('COMMIT');
			return current.status;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	appendAuditEvent(
		event: Omit<
			AgentAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): AgentAuditEvent {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const previous = this.#database
				.prepare(
					`SELECT sequence, event_hash FROM agent_audit_events_v2
					 WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1`,
				)
				.get(event.tenantId) as unknown as
				| { sequence: number; event_hash: string }
				| undefined;
			const sequence = (previous?.sequence ?? 0) + 1;
			const previousHash = previous?.event_hash ?? null;
			const metadataJson = stableMetadata(event.metadata);
			const eventHash = auditHash({
				tenantId: event.tenantId,
				sequence,
				actorId: event.actorId,
				action: event.action,
				subjectType: event.subjectType,
				subjectId: event.subjectId,
				metadataJson,
				occurredAt: event.occurredAt,
				previousHash,
			});
			const created: AgentAuditEvent = {
				...event,
				id: randomUUID(),
				sequence,
				previousHash,
				eventHash,
			};
			this.#database
				.prepare(
					`INSERT INTO agent_audit_events_v2
					 (id, tenant_id, sequence, actor_id, action, subject_type,
					  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					created.id,
					created.tenantId,
					created.sequence,
					created.actorId,
					created.action,
					created.subjectType,
					created.subjectId,
					metadataJson,
					created.occurredAt,
					created.previousHash,
					created.eventHash,
				);
			this.#database.exec('COMMIT');
			return created;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	listAuditEvents(tenantId: string, limit: number): readonly AgentAuditEvent[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM agent_audit_events_v2 WHERE tenant_id = ?
					 ORDER BY sequence DESC LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as AuditRow[]
		).map(fromAuditRow);
	}

	verifyAuditChain(tenantId: string): boolean {
		const events = (
			this.#database
				.prepare(
					`SELECT * FROM agent_audit_events_v2 WHERE tenant_id = ?
					 ORDER BY sequence`,
				)
				.all(tenantId) as unknown as AuditRow[]
		).map(fromAuditRow);
		let previousHash: string | null = null;
		for (const event of events) {
			if (event.previousHash !== previousHash) return false;
			const expected = auditHash({
				tenantId: event.tenantId,
				sequence: event.sequence,
				actorId: event.actorId,
				action: event.action,
				subjectType: event.subjectType,
				subjectId: event.subjectId,
				metadataJson: stableMetadata(event.metadata),
				occurredAt: event.occurredAt,
				previousHash,
			});
			if (expected !== event.eventHash) return false;
			previousHash = event.eventHash;
		}
		return true;
	}

	close(): void {
		this.#database.close();
	}
}
