import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	normalizeActor,
	runModuleMigrations,
	type Actor,
} from '@coreloom/kernel';
import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentExecutionResult,
	AgentOutputContract,
	AgentUsage,
	JsonValue,
} from '@coreloom/harness';
import { usageCostMicros } from '@coreloom/harness/catalog';
import type {
	AgentAuditEvent,
	AgentAuditPage,
	AgentDefinition,
	AgentDefinitionRevision,
	AgentActionInvocation,
	AgentRevisionSkill,
	ModuleAgentBinding,
	ModuleAgentDefinition,
	AgentSkill,
	AgentSkillSnapshot,
	AgentRun,
	AgentRunDetail,
	AgentRunExecution,
	AgentUsageAgent,
	AgentUsageBucket,
	AgentUsageDay,
	AuditChainVerification,
} from '../domain/types.ts';
import { migrations } from './migration.ts';
import type { EncryptedCredential } from './credential-vault.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentSkillKeyError,
	DuplicateActionIdempotencyKeyError,
	DuplicateRunIdempotencyKeyError,
	ModuleAgentBindingConflictError,
	type AgentRepository,
	type PendingAgentAuditEvent,
	type RecoverableRun,
} from './repository.ts';
import { usageDay } from './usage-service.ts';
import { moduleAgentDefinitionHash } from '../server/define-agent.ts';

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
	structured_output_json: string | null;
	output_contract_json: string;
	workflow_run_id: string | null;
	request_hash: string;
	requested_by: string;
	requested_actor_json: string;
	authorization_subject_json: string | null;
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

interface AgentRevisionRow {
	tenant_id: string;
	agent_id: string;
	revision: number;
	agent_key: string;
	name: string;
	description: string;
	instructions: string;
	provider: string;
	model: string;
	allowed_tools_json: string;
	skills_json: string;
	max_steps: number;
	timeout_ms: number;
	temperature_milli: number;
	max_output_tokens: number;
	status: AgentDefinition['status'];
	retained_by: string;
	retained_at: number;
	module_id: string | null;
	module_definition_revision: number | null;
}

interface ModuleAgentDefinitionRow {
	agent_id: string;
	module_id: string;
	agent_key: string;
	definition_revision: number;
	content_hash: string;
	name: string;
	description: string;
	instructions: string;
	allowed_tools_json: string;
	max_steps: number;
	timeout_ms: number;
	temperature_milli: number;
	max_output_tokens: number;
	registered_at: number;
}

interface ModuleAgentBindingRow {
	tenant_id: string;
	agent_id: string;
	provider: string;
	model: string;
	enabled_tools_json: string;
	status: ModuleAgentBinding['status'];
	module_definition_revision: number;
	executable_revision: number;
	revision: number;
	updated_by: string;
	updated_at: number;
}

interface ActionRow {
	id: string;
	tenant_id: string;
	workflow_run_id: string;
	node_run_id: string;
	action_id: string;
	contract_version: number;
	actor_json: string;
	authorization_subject_json: string | null;
	permission_snapshot_json: string;
	input_json: string;
	idempotency_key: string;
	request_hash: string;
	status: AgentActionInvocation['status'];
	output_json: string | null;
	failure_code: string | null;
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

interface UsageRow {
	day: string;
	agent_id: string;
	agent_name: string;
	runs: number;
	input_tokens: number;
	output_tokens: number;
	cost_micro_usd: number | null;
	unpriced_runs: number;
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

function jsonValue(value: string | null): JsonValue | null {
	return value === null ? null : (JSON.parse(value) as JsonValue);
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
	const requestedActor = normalizeActor(
		JSON.parse(row.requested_actor_json) as Actor,
	);
	if (!requestedActor) throw new Error('Stored agent run actor is invalid.');
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
		structuredOutput: jsonValue(row.structured_output_json),
		outputContract: JSON.parse(row.output_contract_json) as AgentOutputContract,
		workflowRunId: row.workflow_run_id,
		provider: row.provider,
		model: row.model,
		requestedBy: row.requested_by,
		requestedActor,
		authorizationSubject:
			row.authorization_subject_json === null
				? null
				: (JSON.parse(
						row.authorization_subject_json,
					) as AgentRun['authorizationSubject']),
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

function fromRevisionRow(row: AgentRevisionRow): AgentDefinitionRevision {
	return {
		tenantId: row.tenant_id,
		agentId: row.agent_id,
		revision: row.revision,
		key: row.agent_key,
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		provider: row.provider,
		model: row.model,
		allowedTools: stringArray(row.allowed_tools_json),
		skills: JSON.parse(row.skills_json) as AgentRevisionSkill[],
		maxSteps: row.max_steps,
		timeoutMs: row.timeout_ms,
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: row.max_output_tokens,
		status: row.status,
		ownership:
			row.module_id === null
				? { kind: 'tenant' }
				: {
						kind: 'module',
						moduleId: row.module_id,
						definitionRevision: row.module_definition_revision!,
					},
		moduleDefinitionRevision: row.module_definition_revision,
		retainedBy: row.retained_by,
		retainedAt: row.retained_at,
	};
}

function fromModuleBindingRow(row: ModuleAgentBindingRow): ModuleAgentBinding {
	return {
		tenantId: row.tenant_id,
		agentId: row.agent_id,
		provider: row.provider,
		model: row.model,
		enabledTools: stringArray(row.enabled_tools_json),
		status: row.status,
		moduleDefinitionRevision: row.module_definition_revision,
		executableRevision: row.executable_revision,
		revision: row.revision,
		updatedBy: row.updated_by,
		updatedAt: row.updated_at,
	};
}

function fromActionRow(row: ActionRow): AgentActionInvocation {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		workflowRunId: row.workflow_run_id,
		nodeRunId: row.node_run_id,
		actionId: row.action_id,
		contractVersion: row.contract_version,
		actor: JSON.parse(row.actor_json) as AgentActionInvocation['actor'],
		authorizationSubject:
			row.authorization_subject_json === null
				? null
				: (JSON.parse(
						row.authorization_subject_json,
					) as AgentActionInvocation['authorizationSubject']),
		permissionSnapshot: stringArray(row.permission_snapshot_json),
		input: JSON.parse(row.input_json) as JsonValue,
		idempotencyKey: row.idempotency_key,
		requestHash: row.request_hash,
		status: row.status,
		output: jsonValue(row.output_json),
		code: row.failure_code,
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

function fromUsageRow(row: UsageRow): AgentUsageBucket {
	return {
		runs: row.runs,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		costMicroUsd: row.cost_micro_usd ?? 0,
		unpricedRuns: row.unpriced_runs,
	};
}

const USAGE_COLUMNS = `COUNT(*) AS runs,
 COALESCE(SUM(input_tokens), 0) AS input_tokens,
 COALESCE(SUM(output_tokens), 0) AS output_tokens,
 COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
 SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs`;

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

const RUN_COLUMNS = `agent_runs.id, agent_runs.tenant_id, agent_id, agent_name, agent_revision,
 instructions_snapshot, provider, model, allowed_tools_json, max_steps,
 COALESCE(agent_run_execution_limits.timeout_ms, agent_runs.timeout_ms) AS timeout_ms,
 temperature_milli,
 COALESCE(agent_run_output_limits.max_output_tokens, ${DEFAULT_MAX_OUTPUT_TOKENS}) AS max_output_tokens,
 trigger, status, input, output, requested_by,
 permission_snapshot_json, tool_grants_json, usage_json, failure_code,
 failure_message, attempt, queued_at, started_at, completed_at, lease_expires_at,
 agent_run_contracts.structured_output_json,
 COALESCE(agent_run_contracts.output_contract_json, '{"kind":"text"}') AS output_contract_json,
 agent_run_contracts.workflow_run_id,
	COALESCE(agent_run_contracts.request_hash, '') AS request_hash,
	agent_run_actors.actor_json AS requested_actor_json,
	agent_run_actors.authorization_subject_json`;
const RUN_FROM = `agent_runs LEFT JOIN agent_run_execution_limits
 ON agent_run_execution_limits.run_id = agent_runs.id
	LEFT JOIN agent_run_output_limits
	ON agent_run_output_limits.run_id = agent_runs.id
	LEFT JOIN agent_run_contracts ON agent_run_contracts.run_id = agent_runs.id
	JOIN agent_run_actors ON agent_run_actors.run_id = agent_runs.id
	 AND agent_run_actors.tenant_id = agent_runs.tenant_id`;
const AGENT_SELECT = `SELECT agent_definitions.*,
 COALESCE(agent_definition_execution_limits.timeout_ms,
 agent_definitions.timeout_ms) AS timeout_ms,
 COALESCE(agent_definition_output_limits.max_output_tokens,
 ${DEFAULT_MAX_OUTPUT_TOKENS}) AS max_output_tokens
 FROM agent_definitions LEFT JOIN agent_definition_execution_limits
 ON agent_definition_execution_limits.agent_id = agent_definitions.id
 LEFT JOIN agent_definition_output_limits
 ON agent_definition_output_limits.agent_id = agent_definitions.id`;
const AGENT_REVISION_SELECT = `SELECT agent_definition_revisions.*,
 agent_revision_ownership.module_id,
 agent_revision_ownership.module_definition_revision
 FROM agent_definition_revisions
 LEFT JOIN agent_revision_ownership
  ON agent_revision_ownership.tenant_id = agent_definition_revisions.tenant_id
 AND agent_revision_ownership.agent_id = agent_definition_revisions.agent_id
 AND agent_revision_ownership.revision = agent_definition_revisions.revision`;

export class SqliteAgentRepository implements AgentRepository {
	readonly #database: DatabaseSync;
	#closed = false;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5_000 });
		this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
		this.#adoptCurrentAgentRevisions();
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

	#revisionSkills(
		tenantId: string,
		agentId: string,
	): readonly AgentRevisionSkill[] {
		return (
			this.#database
				.prepare(
					`SELECT agent_skills.id, agent_skills.skill_key, agent_skills.name,
					 agent_skills.revision, agent_skills.instructions,
					 agent_skills.required_tools_json
					 FROM agent_skill_assignments JOIN agent_skills
					  ON agent_skills.id = agent_skill_assignments.skill_id
					 AND agent_skills.tenant_id = agent_skill_assignments.tenant_id
					 WHERE agent_skill_assignments.tenant_id = ?
					  AND agent_skill_assignments.agent_id = ?
					 ORDER BY agent_skills.skill_key, agent_skills.id`,
				)
				.all(tenantId, agentId) as unknown as {
				id: string;
				skill_key: string;
				name: string;
				revision: number;
				instructions: string;
				required_tools_json: string;
			}[]
		).map((row) => ({
			id: row.id,
			key: row.skill_key,
			name: row.name,
			revision: row.revision,
			instructions: row.instructions,
			requiredTools: stringArray(row.required_tools_json),
		}));
	}

	#retainAgentRevision(agent: AgentDefinition, ignoreExisting = false): void {
		this.#database
			.prepare(
				`INSERT ${ignoreExisting ? 'OR IGNORE ' : ''}INTO agent_definition_revisions
				 (tenant_id, agent_id, revision, agent_key, name, description,
				  instructions, provider, model, allowed_tools_json, skills_json,
				  max_steps, timeout_ms, temperature_milli, max_output_tokens,
				  status, retained_by, retained_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				agent.tenantId,
				agent.id,
				agent.revision,
				agent.key,
				agent.name,
				agent.description,
				agent.instructions,
				agent.provider,
				agent.model,
				JSON.stringify(agent.allowedTools),
				JSON.stringify(this.#revisionSkills(agent.tenantId, agent.id)),
				agent.maxSteps,
				agent.timeoutMs,
				Math.round(agent.temperature * 1_000),
				agent.maxOutputTokens,
				agent.status,
				agent.updatedBy,
				agent.updatedAt,
			);
	}

	#adoptCurrentAgentRevisions(): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			for (const agent of this.listAgentsForRevisionAdoption()) {
				this.#retainAgentRevision(agent, true);
			}
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	/* Constructor-only helper. It avoids calling a public method while the
	   repository is still adopting the pre-ledger current definitions. */
	private listAgentsForRevisionAdoption(): readonly AgentDefinition[] {
		return (
			this.#database
				.prepare(`${AGENT_SELECT} ORDER BY tenant_id, agent_definitions.id`)
				.all() as unknown as AgentRow[]
		).map((row) => {
			const agent = fromAgentRow(row);
			return { ...agent, skillIds: this.#skillIds(agent.tenantId, agent.id) };
		});
	}

	#retainModuleAgentRevision(
		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
	): void {
		this.#database
			.prepare(
				`INSERT INTO agent_definition_revisions
				 (tenant_id, agent_id, revision, agent_key, name, description,
				  instructions, provider, model, allowed_tools_json, skills_json,
				  max_steps, timeout_ms, temperature_milli, max_output_tokens,
				  status, retained_by, retained_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 'active', ?, ?)`,
			)
			.run(
				binding.tenantId,
				definition.id,
				binding.executableRevision,
				definition.key,
				definition.name,
				definition.description,
				definition.instructions,
				binding.provider,
				binding.model,
				JSON.stringify(binding.enabledTools),
				definition.limits.maxSteps,
				definition.limits.timeoutMs,
				Math.round(definition.limits.temperature * 1_000),
				definition.limits.maxOutputTokens,
				binding.updatedBy,
				binding.updatedAt,
			);
		this.#database
			.prepare(
				`INSERT INTO agent_revision_ownership
				 (tenant_id, agent_id, revision, module_id, module_definition_revision)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				binding.tenantId,
				definition.id,
				binding.executableRevision,
				definition.moduleId,
				definition.definitionRevision,
			);
	}

	reconcileModuleAgents(
		definitions: readonly ModuleAgentDefinition[],
		reconciledAt: number,
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const seen = new Set<string>();
			for (const definition of definitions) {
				if (seen.has(definition.id)) {
					throw new Error(`MODULE_AGENT_DUPLICATE: ${definition.id}`);
				}
				seen.add(definition.id);
				const contentHash = moduleAgentDefinitionHash(definition);
				const stored = this.#database
					.prepare('SELECT * FROM module_agent_definitions WHERE agent_id = ?')
					.get(definition.id) as unknown as
					| ModuleAgentDefinitionRow
					| undefined;
				if (stored) {
					if (definition.definitionRevision < stored.definition_revision) {
						throw new Error(
							`MODULE_AGENT_REVISION_DOWNGRADE: ${definition.id} registered revision ${definition.definitionRevision} after ${stored.definition_revision}.`,
						);
					}
					if (definition.definitionRevision === stored.definition_revision) {
						if (contentHash !== stored.content_hash) {
							throw new Error(
								`MODULE_AGENT_REVISION_DRIFT: ${definition.id} changed without a definition revision bump.`,
							);
						}
						continue;
					}
				} else {
					/* The legacy run table references agent_definitions by id only. A
					   retained internal parent keeps that foreign key valid across all
					   tenant bindings without pretending the behavior is tenant-owned. */
					this.#database
						.prepare(
							`INSERT INTO agent_definitions
							 (id, tenant_id, agent_key, name, description, instructions,
							  provider, model, allowed_tools_json, max_steps, timeout_ms,
							  temperature_milli, status, revision, created_by, created_at,
							  updated_by, updated_at)
							 VALUES (?, '__coreloom_module_agents__', ?, ?, ?, ?,
							  'local-simulation', 'deterministic-v1', ?, ?, ?, ?, 'archived',
							  ?, ?, ?, ?, ?)`,
						)
						.run(
							definition.id,
							definition.id,
							definition.name,
							definition.description,
							definition.instructions,
							JSON.stringify(definition.allowedTools),
							definition.limits.maxSteps,
							Math.min(definition.limits.timeoutMs, 300_000),
							Math.round(definition.limits.temperature * 1_000),
							definition.definitionRevision,
							`module:${definition.moduleId}`,
							reconciledAt,
							`module:${definition.moduleId}`,
							reconciledAt,
						);
				}

				if (stored) {
					this.#database
						.prepare(
							`UPDATE agent_definitions SET name = ?, description = ?,
							 instructions = ?, allowed_tools_json = ?, max_steps = ?,
							 timeout_ms = ?, temperature_milli = ?, revision = ?,
							 updated_by = ?, updated_at = ? WHERE id = ?`,
						)
						.run(
							definition.name,
							definition.description,
							definition.instructions,
							JSON.stringify(definition.allowedTools),
							definition.limits.maxSteps,
							Math.min(definition.limits.timeoutMs, 300_000),
							Math.round(definition.limits.temperature * 1_000),
							definition.definitionRevision,
							`module:${definition.moduleId}`,
							reconciledAt,
							definition.id,
						);
				}

				this.#database
					.prepare(
						`INSERT INTO module_agent_definitions
						 (agent_id, module_id, agent_key, definition_revision, content_hash,
						  name, description, instructions, allowed_tools_json, max_steps,
						  timeout_ms, temperature_milli, max_output_tokens, registered_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(agent_id) DO UPDATE SET
						  definition_revision = excluded.definition_revision,
						  content_hash = excluded.content_hash, name = excluded.name,
						  description = excluded.description, instructions = excluded.instructions,
						  allowed_tools_json = excluded.allowed_tools_json,
						  max_steps = excluded.max_steps, timeout_ms = excluded.timeout_ms,
						  temperature_milli = excluded.temperature_milli,
						  max_output_tokens = excluded.max_output_tokens,
						  registered_at = excluded.registered_at`,
					)
					.run(
						definition.id,
						definition.moduleId,
						definition.key,
						definition.definitionRevision,
						contentHash,
						definition.name,
						definition.description,
						definition.instructions,
						JSON.stringify(definition.allowedTools),
						definition.limits.maxSteps,
						definition.limits.timeoutMs,
						Math.round(definition.limits.temperature * 1_000),
						definition.limits.maxOutputTokens,
						reconciledAt,
					);

				if (stored) {
					const rows = this.#database
						.prepare('SELECT * FROM module_agent_bindings WHERE agent_id = ?')
						.all(definition.id) as unknown as ModuleAgentBindingRow[];
					for (const row of rows) {
						const previous = fromModuleBindingRow(row);
						const binding: ModuleAgentBinding = {
							...previous,
							enabledTools: previous.enabledTools.filter((tool) =>
								definition.allowedTools.includes(tool),
							),
							moduleDefinitionRevision: definition.definitionRevision,
							executableRevision: previous.executableRevision + 1,
							revision: previous.revision + 1,
							updatedBy: `module:${definition.moduleId}`,
							updatedAt: reconciledAt,
						};
						this.#database
							.prepare(
								`UPDATE module_agent_bindings SET enabled_tools_json = ?,
								 module_definition_revision = ?, executable_revision = ?,
								 revision = ?, updated_by = ?, updated_at = ?
								 WHERE tenant_id = ? AND agent_id = ?`,
							)
							.run(
								JSON.stringify(binding.enabledTools),
								binding.moduleDefinitionRevision,
								binding.executableRevision,
								binding.revision,
								binding.updatedBy,
								binding.updatedAt,
								binding.tenantId,
								binding.agentId,
							);
						this.#retainModuleAgentRevision(binding, definition);
						this.#appendAuditEvent({
							tenantId: binding.tenantId,
							actorId: binding.updatedBy,
							action: 'module-agent.definition-reconciled',
							subjectType: 'agent',
							subjectId: definition.id,
							metadata: {
								moduleId: definition.moduleId,
								previousDefinitionRevision: previous.moduleDefinitionRevision,
								definitionRevision: definition.definitionRevision,
								executableRevision: binding.executableRevision,
								bindingRevision: binding.revision,
								removedTools:
									previous.enabledTools.length - binding.enabledTools.length,
							},
							occurredAt: reconciledAt,
						});
					}
				}
			}
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	listModuleAgentBindings(tenantId: string): readonly ModuleAgentBinding[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM module_agent_bindings WHERE tenant_id = ?
					 ORDER BY agent_id`,
				)
				.all(tenantId) as unknown as ModuleAgentBindingRow[]
		).map(fromModuleBindingRow);
	}

	getModuleAgentBinding(
		tenantId: string,
		agentId: string,
	): ModuleAgentBinding | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM module_agent_bindings WHERE tenant_id = ? AND agent_id = ?',
			)
			.get(tenantId, agentId) as unknown as ModuleAgentBindingRow | undefined;
		return row ? fromModuleBindingRow(row) : null;
	}

	saveModuleAgentBinding(
		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
		expectedRevision: number,
		audit: PendingAgentAuditEvent,
	): ModuleAgentBinding {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			if (expectedRevision === 0) {
				this.#database
					.prepare(
						`INSERT INTO module_agent_bindings
						 (tenant_id, agent_id, provider, model, enabled_tools_json, status,
						  module_definition_revision, executable_revision, revision,
						  updated_by, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						binding.tenantId,
						binding.agentId,
						binding.provider,
						binding.model,
						JSON.stringify(binding.enabledTools),
						binding.status,
						binding.moduleDefinitionRevision,
						binding.executableRevision,
						binding.revision,
						binding.updatedBy,
						binding.updatedAt,
					);
			} else {
				const result = this.#database
					.prepare(
						`UPDATE module_agent_bindings SET provider = ?, model = ?,
						 enabled_tools_json = ?, status = ?, module_definition_revision = ?,
						 executable_revision = ?, revision = ?, updated_by = ?, updated_at = ?
						 WHERE tenant_id = ? AND agent_id = ? AND revision = ?`,
					)
					.run(
						binding.provider,
						binding.model,
						JSON.stringify(binding.enabledTools),
						binding.status,
						binding.moduleDefinitionRevision,
						binding.executableRevision,
						binding.revision,
						binding.updatedBy,
						binding.updatedAt,
						binding.tenantId,
						binding.agentId,
						expectedRevision,
					);
				if (result.changes !== 1) throw new ModuleAgentBindingConflictError();
			}
			const existingRevision = this.#database
				.prepare(
					`SELECT 1 FROM agent_definition_revisions
					 WHERE tenant_id = ? AND agent_id = ? AND revision = ?`,
				)
				.get(binding.tenantId, binding.agentId, binding.executableRevision);
			if (!existingRevision)
				this.#retainModuleAgentRevision(binding, definition);
			this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (
				expectedRevision === 0 &&
				String(error).includes('module_agent_bindings.tenant_id')
			) {
				throw new ModuleAgentBindingConflictError();
			}
			throw error;
		}
		return binding;
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

	providerUsage(
		tenantId: string,
		providerId: string,
	): { readonly definitions: number; readonly pendingRuns: number } {
		const definitions = this.#database
			.prepare(
				`SELECT
				  (SELECT COUNT(*) FROM agent_definitions
				   WHERE tenant_id = ? AND provider = ? AND status <> 'archived') +
				  (SELECT COUNT(*) FROM module_agent_bindings
				   WHERE tenant_id = ? AND provider = ?) AS count`,
			)
			.get(tenantId, providerId, tenantId, providerId) as unknown as {
			count: number;
		};
		const pendingRuns = this.#database
			.prepare(
				`SELECT COUNT(*) AS count FROM agent_runs
				 WHERE tenant_id = ? AND provider = ? AND status IN ('queued', 'running')`,
			)
			.get(tenantId, providerId) as unknown as { count: number };
		return {
			definitions: definitions.count,
			pendingRuns: pendingRuns.count,
		};
	}

	agentUsage(
		tenantId: string,
		agentId: string,
	): {
		readonly runs: number;
		readonly pendingRuns: number;
		readonly assignments: number;
	} {
		const counts = this.#database
			.prepare(
				`SELECT
				  (SELECT COUNT(*) FROM agent_runs
				   WHERE tenant_id = ? AND agent_id = ?) AS runs,
				  (SELECT COUNT(*) FROM agent_runs
				   WHERE tenant_id = ? AND agent_id = ?
				     AND status IN ('queued', 'running')) AS pending_runs,
				  (SELECT COUNT(*) FROM agent_skill_assignments
				   WHERE tenant_id = ? AND agent_id = ?) AS assignments`,
			)
			.get(
				tenantId,
				agentId,
				tenantId,
				agentId,
				tenantId,
				agentId,
			) as unknown as {
			runs: number;
			pending_runs: number;
			assignments: number;
		};
		return {
			runs: counts.runs,
			pendingRuns: counts.pending_runs,
			assignments: counts.assignments,
		};
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

	getAgentRevision(
		tenantId: string,
		agentId: string,
		revision: number,
	): AgentDefinitionRevision | null {
		const row = this.#database
			.prepare(
				`${AGENT_REVISION_SELECT}
				 WHERE agent_definition_revisions.tenant_id = ?
				  AND agent_definition_revisions.agent_id = ?
				  AND agent_definition_revisions.revision = ?`,
			)
			.get(tenantId, agentId, revision) as unknown as
			| AgentRevisionRow
			| undefined;
		return row ? fromRevisionRow(row) : null;
	}

	listAgentRevisions(tenantId: string): readonly AgentDefinitionRevision[] {
		return (
			this.#database
				.prepare(
					`${AGENT_REVISION_SELECT}
					 WHERE agent_definition_revisions.tenant_id = ?
					 ORDER BY lower(agent_definition_revisions.name),
					  agent_definition_revisions.agent_id,
					  agent_definition_revisions.revision DESC`,
				)
				.all(tenantId) as unknown as AgentRevisionRow[]
		).map(fromRevisionRow);
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
			this.#retainAgentRevision(agent);
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
			this.#retainAgentRevision(agent);
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

	deleteAgent(tenantId: string, agentId: string): boolean {
		return (
			this.#database
				.prepare('DELETE FROM agent_definitions WHERE tenant_id = ? AND id = ?')
				.run(tenantId, agentId).changes === 1
		);
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

	skillUsage(
		tenantId: string,
		skillId: string,
	): { readonly assignments: number; readonly activeDefinitions: number } {
		const counts = this.#database
			.prepare(
				`SELECT COUNT(*) AS assignments,
				 SUM(CASE WHEN agent_definitions.status = 'active' THEN 1 ELSE 0 END) AS active_definitions
				 FROM agent_skill_assignments
				 JOIN agent_definitions
				   ON agent_definitions.id = agent_skill_assignments.agent_id
				  AND agent_definitions.tenant_id = agent_skill_assignments.tenant_id
				 WHERE agent_skill_assignments.tenant_id = ?
				   AND agent_skill_assignments.skill_id = ?`,
			)
			.get(tenantId, skillId) as unknown as {
			assignments: number;
			active_definitions: number | null;
		};
		return {
			assignments: counts.assignments,
			activeDefinitions: counts.active_definitions ?? 0,
		};
	}

	deleteSkill(tenantId: string, skillId: string): boolean {
		return (
			this.#database
				.prepare('DELETE FROM agent_skills WHERE tenant_id = ? AND id = ?')
				.run(tenantId, skillId).changes === 1
		);
	}

	listRuns(tenantId: string, limit: number): readonly AgentRun[] {
		return (
			this.#database
				.prepare(
					`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = ?
					 ORDER BY queued_at DESC, agent_runs.id DESC LIMIT ?`,
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
				`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = ? AND agent_runs.id = ?`,
			)
			.get(tenantId, runId) as unknown as RunRow | undefined;
		if (!row) return null;
		const events = this.listRunEvents(tenantId, runId, 0);
		return {
			...fromRunRow(row),
			skillSnapshots: this.#skillSnapshots(row.id),
			events,
		};
	}

	listRunEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
	): readonly AgentExecutionEvent[] {
		return (
			this.#database
				.prepare(
					`SELECT sequence, event_type, message, metadata_json, occurred_at
					 FROM agent_run_events WHERE tenant_id = ? AND run_id = ?
					 AND sequence > ? ORDER BY sequence`,
				)
				.all(tenantId, runId, afterSequence) as unknown as RunEventRow[]
		).map(
			(event): AgentExecutionEvent => ({
				sequence: event.sequence,
				type: event.event_type,
				timestamp: event.occurred_at,
				message: event.message,
				metadata: metadata(event.metadata_json),
			}),
		);
	}

	findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentRun | null {
		const row = this.#database
			.prepare(
				`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM}
				 WHERE agent_runs.tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, idempotencyKey) as unknown as RunRow | undefined;
		if (!row) return null;
		const run = fromRunRow(row);
		return { ...run, skillSnapshots: this.#skillSnapshots(run.id) };
	}

	enqueueRun(
		execution: AgentRunExecution,
		idempotencyKey: string | null,
		audit: PendingAgentAuditEvent,
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
			this.#database
				.prepare(
					`INSERT INTO agent_run_contracts
					 (run_id, tenant_id, workflow_run_id, output_contract_json,
					  structured_output_json, request_hash)
					 VALUES (?, ?, ?, ?, NULL, ?)`,
				)
				.run(
					run.id,
					run.tenantId,
					run.workflowRunId,
					JSON.stringify(run.outputContract),
					createHash('sha256')
						.update(
							JSON.stringify([
								run.agentId,
								run.agentRevision,
								run.input,
								run.outputContract,
								run.workflowRunId,
							]),
						)
						.digest('hex'),
				);
			this.#database
				.prepare(
					`INSERT INTO agent_run_actors
					 (run_id, tenant_id, actor_json, authorization_subject_json)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(
					run.id,
					run.tenantId,
					JSON.stringify(run.requestedActor),
					run.authorizationSubject
						? JSON.stringify(run.authorizationSubject)
						: null,
				);
			this.#appendAuditEvent(audit);
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
		audit: PendingAgentAuditEvent,
	): AgentRunExecution | null {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const result = this.#database
				.prepare(
					`UPDATE agent_runs SET status = 'running', lease_owner = ?,
					 lease_expires_at = ?, started_at = COALESCE(started_at, ?),
					 attempt = attempt + 1
					 WHERE tenant_id = ? AND id = ? AND
					 (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))`,
				)
				.run(workerId, leaseExpiresAt, now, tenantId, runId, now);
			if (result.changes !== 1) {
				this.#database.exec('COMMIT');
				return null;
			}
			const row = this.#database
				.prepare(
					`SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = ? AND agent_runs.id = ?`,
				)
				.get(tenantId, runId) as unknown as RunRow;
			const execution = executionFromRow(row);
			this.#appendAuditEvent({
				...audit,
				metadata: { ...audit.metadata, attempt: execution.run.attempt },
			});
			this.#database.exec('COMMIT');
			return {
				...execution,
				run: {
					...execution.run,
					skillSnapshots: this.#skillSnapshots(execution.run.id),
				},
			};
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
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

	/* Settling the run and projecting its cost share one transaction: a run that
	   succeeded but is missing from the rollup would understate every budget
	   check that follows it. */
	completeRun(
		tenantId: string,
		runId: string,
		workerId: string,
		result: AgentExecutionResult,
		audit: PendingAgentAuditEvent,
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
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
			this.#database
				.prepare(
					`UPDATE agent_run_contracts SET structured_output_json = ?
					 WHERE tenant_id = ? AND run_id = ?`,
				)
				.run(
					result.structuredOutput === undefined
						? null
						: JSON.stringify(result.structuredOutput),
					tenantId,
					runId,
				);
			const run = this.#database
				.prepare(
					`SELECT agent_id, agent_name, model FROM agent_runs
					 WHERE tenant_id = ? AND id = ?`,
				)
				.get(tenantId, runId) as unknown as {
				agent_id: string;
				agent_name: string;
				model: string;
			};
			this.#database
				.prepare(
					`INSERT INTO agent_run_costs
					 (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
					  output_tokens, cost_micro_usd, completed_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(run_id) DO UPDATE SET
					  input_tokens = excluded.input_tokens,
					  output_tokens = excluded.output_tokens,
					  cost_micro_usd = excluded.cost_micro_usd,
					  day = excluded.day, completed_at = excluded.completed_at`,
				)
				.run(
					runId,
					tenantId,
					run.agent_id,
					run.agent_name,
					run.model,
					usageDay(result.completedAt),
					Math.max(0, Math.trunc(result.usage.inputTokens)),
					Math.max(0, Math.trunc(result.usage.outputTokens)),
					usageCostMicros(run.model, result.usage),
					result.completedAt,
				);
			this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const update = this.#database
				.prepare(
					`UPDATE agent_runs SET status = 'failed', failure_code = ?,
					 failure_message = ?, completed_at = ?, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = ? AND id = ?
					 AND status = 'running' AND lease_owner = ?`,
				)
				.run(code, message, completedAt, tenantId, runId, workerId);
			if (update.changes !== 1) throw new Error('Agent run lease was lost.');
			this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
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
			this.#appendAuditEvent({
				...audit,
				metadata: { ...audit.metadata, previousStatus: current.status },
			});
			this.#database.exec('COMMIT');
			return current.status;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	enqueueAction(
		invocation: AgentActionInvocation,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.#database
				.prepare(
					`INSERT INTO agent_action_invocations
					 (id, tenant_id, workflow_run_id, node_run_id, action_id,
					  contract_version, actor_json, authorization_subject_json, permission_snapshot_json,
					  input_json, idempotency_key, request_hash, status, output_json,
					  failure_code, attempt, queued_at, started_at, completed_at,
					  lease_owner, lease_expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL,
					  0, ?, NULL, NULL, NULL, NULL)`,
				)
				.run(
					invocation.id,
					invocation.tenantId,
					invocation.workflowRunId,
					invocation.nodeRunId,
					invocation.actionId,
					invocation.contractVersion,
					JSON.stringify(invocation.actor),
					JSON.stringify(invocation.authorizationSubject),
					JSON.stringify(invocation.permissionSnapshot),
					JSON.stringify(invocation.input),
					invocation.idempotencyKey,
					invocation.requestHash,
					invocation.queuedAt,
				);
			this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
		} catch (error) {
			this.#database.exec('ROLLBACK');
			if (String(error).includes('agent_action_invocations.tenant_id')) {
				throw new DuplicateActionIdempotencyKeyError();
			}
			throw error;
		}
		return invocation;
	}

	getAction(
		tenantId: string,
		invocationId: string,
	): AgentActionInvocation | null {
		const row = this.#database
			.prepare(
				`SELECT * FROM agent_action_invocations
				 WHERE tenant_id = ? AND id = ?`,
			)
			.get(tenantId, invocationId) as unknown as ActionRow | undefined;
		return row ? fromActionRow(row) : null;
	}

	findActionByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentActionInvocation | null {
		const row = this.#database
			.prepare(
				`SELECT * FROM agent_action_invocations
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, idempotencyKey) as unknown as ActionRow | undefined;
		return row ? fromActionRow(row) : null;
	}

	listRecoverableActions(
		now: number,
		limit: number,
	): readonly { readonly tenantId: string; readonly invocationId: string }[] {
		return (
			this.#database
				.prepare(
					`SELECT tenant_id, id FROM agent_action_invocations
					 WHERE status = 'queued'
					 OR (status = 'running' AND lease_expires_at < ?)
					 ORDER BY queued_at, id LIMIT ?`,
				)
				.all(now, limit) as unknown as {
				tenant_id: string;
				id: string;
			}[]
		).map((row) => ({
			tenantId: row.tenant_id,
			invocationId: row.id,
		}));
	}

	claimAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation | null {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const updated = this.#database
				.prepare(
					`UPDATE agent_action_invocations SET status = 'running',
					 lease_owner = ?, lease_expires_at = ?,
					 started_at = COALESCE(started_at, ?), attempt = attempt + 1
					 WHERE tenant_id = ? AND id = ?
					 AND (status = 'queued' OR
					  (status = 'running' AND lease_expires_at < ?))`,
				)
				.run(workerId, leaseExpiresAt, now, tenantId, invocationId, now);
			if (updated.changes !== 1) {
				this.#database.exec('COMMIT');
				return null;
			}
			const invocation = this.getAction(tenantId, invocationId)!;
			this.#appendAuditEvent({
				...audit,
				metadata: { ...audit.metadata, attempt: invocation.attempt },
			});
			this.#database.exec('COMMIT');
			return invocation;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	renewActionLease(
		tenantId: string,
		invocationId: string,
		workerId: string,
		leaseExpiresAt: number,
	): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE agent_action_invocations SET lease_expires_at = ?
					 WHERE tenant_id = ? AND id = ? AND status = 'running'
					 AND lease_owner = ?`,
				)
				.run(leaseExpiresAt, tenantId, invocationId, workerId).changes === 1
		);
	}

	completeAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		output: JsonValue,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): boolean {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const changed =
				this.#database
					.prepare(
						`UPDATE agent_action_invocations SET status = 'succeeded',
					 output_json = ?, completed_at = ?, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = ? AND id = ?
					 AND status = 'running' AND lease_owner = ?`,
					)
					.run(
						JSON.stringify(output),
						completedAt,
						tenantId,
						invocationId,
						workerId,
					).changes === 1;
			if (changed) this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
			return changed;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	failAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		code: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): boolean {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const changed =
				this.#database
					.prepare(
						`UPDATE agent_action_invocations SET status = 'failed',
					 failure_code = ?, completed_at = ?, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = ? AND id = ?
					 AND status = 'running' AND lease_owner = ?`,
					)
					.run(code, completedAt, tenantId, invocationId, workerId).changes ===
				1;
			if (changed) this.#appendAuditEvent(audit);
			this.#database.exec('COMMIT');
			return changed;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	cancelAction(
		tenantId: string,
		invocationId: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation['status'] | null {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const current = this.getAction(tenantId, invocationId);
			if (!current || !['queued', 'running'].includes(current.status)) {
				this.#database.exec('COMMIT');
				return null;
			}
			const changed = this.#database
				.prepare(
					`UPDATE agent_action_invocations SET status = 'cancelled',
					 failure_code = 'ACTION_CANCELLED', completed_at = ?,
					 lease_owner = NULL, lease_expires_at = NULL
					 WHERE tenant_id = ? AND id = ? AND status IN ('queued', 'running')`,
				)
				.run(completedAt, tenantId, invocationId);
			if (changed.changes !== 1) {
				this.#database.exec('COMMIT');
				return null;
			}
			this.#appendAuditEvent({
				...audit,
				metadata: { ...audit.metadata, previousStatus: current.status },
			});
			this.#database.exec('COMMIT');
			return current.status;
		} catch (error) {
			this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	#appendAuditEvent(event: PendingAgentAuditEvent): AgentAuditEvent {
		const previous = this.#database
			.prepare(
				`SELECT sequence, event_hash FROM agent_audit_events_v4
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
				`INSERT INTO agent_audit_events_v4
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
		return created;
	}

	appendAuditEvent(event: PendingAgentAuditEvent): AgentAuditEvent {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const created = this.#appendAuditEvent(event);
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
					`SELECT * FROM agent_audit_events_v4 WHERE tenant_id = ?
					 ORDER BY sequence DESC LIMIT ?`,
				)
				.all(tenantId, limit) as unknown as AuditRow[]
		).map(fromAuditRow);
	}

	pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): AgentAuditPage {
		const rows = (cursor
			? this.#database
					.prepare(
						`SELECT * FROM agent_audit_events_v4 WHERE tenant_id = ?
							 AND (occurred_at < ? OR (occurred_at = ? AND sequence < ?))
							 ORDER BY occurred_at DESC, sequence DESC LIMIT ?`,
					)
					.all(
						tenantId,
						cursor.occurredAt,
						cursor.occurredAt,
						cursor.sequence,
						limit + 1,
					)
			: this.#database
					.prepare(
						`SELECT * FROM agent_audit_events_v4 WHERE tenant_id = ?
							 ORDER BY occurred_at DESC, sequence DESC LIMIT ?`,
					)
					.all(tenantId, limit + 1)) as unknown as AuditRow[];
		const page = rows.slice(0, limit).map(fromAuditRow);
		const last = page[page.length - 1];
		return {
			events: page,
			nextCursor:
				rows.length > limit && last
					? `${last.occurredAt}:${last.sequence}`
					: null,
		};
	}

	verifyAuditChain(tenantId: string): boolean {
		return this.verifyAuditChainDetailed(tenantId).verified;
	}

	verifyAuditChainDetailed(tenantId: string): AuditChainVerification {
		const events = (
			this.#database
				.prepare(
					`SELECT * FROM agent_audit_events_v4 WHERE tenant_id = ?
					 ORDER BY sequence`,
				)
				.all(tenantId) as unknown as AuditRow[]
		).map(fromAuditRow);
		let previousHash: string | null = null;
		for (const event of events) {
			if (event.previousHash !== previousHash) {
				return { verified: false, brokenAt: event.id };
			}
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
			if (expected !== event.eventHash) {
				return { verified: false, brokenAt: event.id };
			}
			previousHash = event.eventHash;
		}
		return { verified: true, brokenAt: null };
	}

	usageByDay(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): readonly AgentUsageDay[] {
		return (
			this.#database
				.prepare(
					`SELECT day, ${USAGE_COLUMNS} FROM agent_run_costs
					 WHERE tenant_id = ? AND day BETWEEN ? AND ?
					 GROUP BY day ORDER BY day`,
				)
				.all(tenantId, fromDay, toDay) as unknown as UsageRow[]
		).map((row) => ({ day: row.day, ...fromUsageRow(row) }));
	}

	usageByAgent(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): readonly AgentUsageAgent[] {
		return (
			this.#database
				.prepare(
					`SELECT agent_id, MAX(agent_name) AS agent_name, ${USAGE_COLUMNS}
					 FROM agent_run_costs WHERE tenant_id = ? AND day BETWEEN ? AND ?
					 GROUP BY agent_id ORDER BY cost_micro_usd DESC, agent_id`,
				)
				.all(tenantId, fromDay, toDay) as unknown as UsageRow[]
		).map((row) => ({
			agentId: row.agent_id,
			agentName: row.agent_name,
			...fromUsageRow(row),
		}));
	}

	usageTotal(
		tenantId: string,
		fromDay: string,
		agentId: string | null,
	): AgentUsageBucket {
		const row = (agentId === null
			? this.#database
					.prepare(
						`SELECT ${USAGE_COLUMNS} FROM agent_run_costs
							 WHERE tenant_id = ? AND day >= ?`,
					)
					.get(tenantId, fromDay)
			: this.#database
					.prepare(
						`SELECT ${USAGE_COLUMNS} FROM agent_run_costs
							 WHERE tenant_id = ? AND agent_id = ? AND day >= ?`,
					)
					.get(tenantId, agentId, fromDay)) as unknown as UsageRow | undefined;
		return row
			? fromUsageRow(row)
			: {
					runs: 0,
					inputTokens: 0,
					outputTokens: 0,
					costMicroUsd: 0,
					unpricedRuns: 0,
				};
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}
