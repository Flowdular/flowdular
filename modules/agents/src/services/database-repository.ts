import { createHash, randomUUID } from 'node:crypto';
import {
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseTransaction,
} from '@flowdular/database';
import { normalizeActor, type Actor } from '@flowdular/kernel';
import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentExecutionResult,
	AgentOutputContract,
	AgentUsage,
	JsonValue,
} from '@flowdular/harness';
import { usageCostMicros } from '@flowdular/harness/catalog';
import type {
	AgentAuditEvent,
	AgentAuditPage,
	AgentDefinition,
	AgentDefinitionRevision,
	AgentActionInvocation,
	AgentRevisionProcedure,
	ModuleAgentBinding,
	ModuleAgentDefinition,
	AgentProcedure,
	AgentProcedureSnapshot,
	AgentRun,
	AgentRunDetail,
	AgentRunExecution,
	AgentUsageAgent,
	AgentUsageBucket,
	AgentUsageDay,
	AuditChainVerification,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { EncryptedCredential } from './credential-vault.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentProcedureKeyError,
	DuplicateActionIdempotencyKeyError,
	DuplicateRunIdempotencyKeyError,
	ModuleAgentBindingConflictError,
	type AgentRepository,
	type AgentRunExportCursor,
	type ExportedAgentRun,
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
	timeout_ms: number | string;
	temperature_milli: number;
	max_output_tokens: number | string;
	status: AgentDefinition['status'];
	revision: number;
	created_by: string;
	created_at: number | string;
	updated_by: string;
	updated_at: number | string;
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
	timeout_ms: number | string;
	temperature_milli: number;
	max_output_tokens: number | string;
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
	queued_at: number | string;
	started_at: number | string | null;
	completed_at: number | string | null;
	lease_expires_at: number | string | null;
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
	timeout_ms: number | string;
	temperature_milli: number;
	max_output_tokens: number | string;
	status: AgentDefinition['status'];
	retained_by: string;
	retained_at: number | string;
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
	timeout_ms: number | string;
	temperature_milli: number;
	max_output_tokens: number | string;
	registered_at: number | string;
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
	updated_at: number | string;
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
	queued_at: number | string;
	started_at: number | string | null;
	completed_at: number | string | null;
	lease_expires_at: number | string | null;
}

interface RunEventRow {
	sequence: number | string;
	event_type: AgentExecutionEvent['type'];
	message: string;
	metadata_json: string;
	occurred_at: number | string;
}

/** The run id a page of events carries, so one query can serve many runs. */
interface RunEventPageRow extends RunEventRow {
	run_id: string;
}

interface AuditRow {
	id: string;
	tenant_id: string;
	sequence: number | string;
	actor_id: string;
	action: string;
	subject_type: AgentAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number | string;
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
	status: AgentProcedure['status'];
	revision: number;
	created_by: string;
	created_at: number | string;
	updated_by: string;
	updated_at: number | string;
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
	runs: number | string;
	input_tokens: number | string;
	output_tokens: number | string;
	cost_micro_usd: number | string | null;
	unpriced_runs: number | string;
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
		procedureIds: [],
		maxSteps: row.max_steps,
		timeoutMs: integer(row.timeout_ms),
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: integer(row.max_output_tokens),
		status: row.status,
		revision: row.revision,
		createdBy: row.created_by,
		createdAt: integer(row.created_at),
		updatedBy: row.updated_by,
		updatedAt: integer(row.updated_at),
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
		procedureSnapshots: [],
		usage: usage(row.usage_json),
		failureCode: row.failure_code,
		failureMessage: row.failure_message,
		attempt: row.attempt,
		queuedAt: integer(row.queued_at),
		startedAt: integerOrNull(row.started_at),
		completedAt: integerOrNull(row.completed_at),
		leaseExpiresAt: integerOrNull(row.lease_expires_at),
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
		procedures: JSON.parse(row.skills_json) as AgentRevisionProcedure[],
		maxSteps: row.max_steps,
		timeoutMs: integer(row.timeout_ms),
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: integer(row.max_output_tokens),
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
		retainedAt: integer(row.retained_at),
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
		updatedAt: integer(row.updated_at),
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
		queuedAt: integer(row.queued_at),
		startedAt: integerOrNull(row.started_at),
		completedAt: integerOrNull(row.completed_at),
		leaseExpiresAt: integerOrNull(row.lease_expires_at),
	};
}

function fromSkillRow(row: SkillRow): AgentProcedure {
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
		createdAt: integer(row.created_at),
		updatedBy: row.updated_by,
		updatedAt: integer(row.updated_at),
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
		timeoutMs: integer(row.timeout_ms),
		temperature: row.temperature_milli / 1_000,
		maxOutputTokens: integer(row.max_output_tokens),
	};
	return { run: fromRunRow(row), definition };
}

/* SUM() over BIGINT is NUMERIC in PostgreSQL, and the driver hands NUMERIC
   back as a string. Aggregates leave this repository as numbers. */
function integer(value: number | string | null): number {
	return typeof value === 'number' ? value : Number(value ?? 0);
}

/* A nullable BIGINT must stay null: coercing it to 0 would turn "never started"
   into "started at the epoch". */
function integerOrNull(value: number | string | null): number | null {
	return value === null ? null : integer(value);
}

function fromUsageRow(row: UsageRow): AgentUsageBucket {
	return {
		runs: integer(row.runs),
		inputTokens: integer(row.input_tokens),
		outputTokens: integer(row.output_tokens),
		costMicroUsd: integer(row.cost_micro_usd),
		unpricedRuns: integer(row.unpriced_runs),
	};
}

const USAGE_COLUMNS = `COUNT(*) AS runs,
 COALESCE(SUM(input_tokens), 0) AS input_tokens,
 COALESCE(SUM(output_tokens), 0) AS output_tokens,
 COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd,
 SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_runs`;

function fromRunEventRow(row: RunEventRow): AgentExecutionEvent {
	return {
		sequence: integer(row.sequence),
		type: row.event_type,
		timestamp: integer(row.occurred_at),
		message: row.message,
		metadata: metadata(row.metadata_json),
	};
}

function fromAuditRow(row: AuditRow): AgentAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: integer(row.sequence),
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: metadata(row.metadata_json),
		occurredAt: integer(row.occurred_at),
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

export interface AgentsPersistenceStatements {
	readonly procedureIds: string;
	readonly procedureSnapshots: string;
	readonly setAgentSkills1: string;
	readonly setAgentSkills2: string;
	readonly revisionSkills: string;
	readonly retainAgentRevision1: string;
	readonly retainAgentRevision2: string;
	readonly listAgentsForRevisionAdoption: string;
	readonly retainModuleAgentRevision1: string;
	readonly retainModuleAgentRevision2: string;
	readonly reconcileModuleAgents1: string;
	readonly reconcileModuleAgents2: string;
	readonly reconcileModuleAgents3: string;
	readonly reconcileModuleAgents4: string;
	readonly reconcileModuleAgents5: string;
	readonly reconcileModuleAgents6: string;
	readonly listModuleAgentBindings: string;
	readonly getModuleAgentBinding: string;
	readonly saveModuleAgentBinding1: string;
	readonly saveModuleAgentBinding2: string;
	readonly saveModuleAgentBinding3: string;
	readonly listAgents: string;
	readonly providerUsage1: string;
	readonly providerUsage2: string;
	readonly agentUsage: string;
	readonly getAgent: string;
	readonly getAgentRevision: string;
	readonly listAgentRevisions: string;
	readonly createAgent1: string;
	readonly createAgent2: string;
	readonly createAgent3: string;
	readonly updateAgent1: string;
	readonly updateAgent2: string;
	readonly updateAgent3: string;
	readonly deleteAgent: string;
	readonly listProcedures: string;
	readonly getProcedure: string;
	readonly createProcedure: string;
	readonly updateProcedure: string;
	readonly procedureUsage: string;
	readonly deleteProcedure: string;
	readonly listRuns: string;
	readonly getRun: string;
	readonly listRunEvents: string;
	readonly findRunByIdempotencyKey: string;
	readonly enqueueRun1: string;
	readonly enqueueRun2: string;
	readonly enqueueRun3: string;
	readonly enqueueRun4: string;
	readonly enqueueRun5: string;
	readonly enqueueRun6: string;
	readonly listRecoverableRuns: string;
	readonly claimRun1: string;
	readonly claimRun2: string;
	readonly renewLease: string;
	readonly consumeRunGrant1: string;
	readonly consumeRunGrant2: string;
	readonly appendRunEvent: string;
	readonly completeRun1: string;
	readonly completeRun2: string;
	readonly completeRun3: string;
	readonly completeRun4: string;
	readonly failRun: string;
	readonly cancelRun1: string;
	readonly cancelRun2: string;
	readonly enqueueAction: string;
	readonly getAction: string;
	readonly findActionByIdempotencyKey: string;
	readonly listRecoverableActions: string;
	readonly claimAction: string;
	readonly renewActionLease: string;
	readonly completeAction: string;
	readonly failAction: string;
	readonly cancelAction: string;
	readonly exportRunsPage1: string;
	readonly exportRunsPage2: string;
	readonly exportRunEvents: string;
	readonly deleteSettledRunsBefore: string;
	readonly deleteRunsRequestedBy: string;
	readonly appendAuditEvent1: string;
	readonly appendAuditEvent2: string;
	readonly pruneMeterRefusals: string;
	readonly claimMeterRefusal: string;
	readonly listAuditEvents: string;
	readonly exportAuditEventsPage: string;
	readonly pageAuditEvents1: string;
	readonly pageAuditEvents2: string;
	readonly verifyAuditChainDetailed: string;
	readonly usageByDay: string;
	readonly usageByAgent: string;
	readonly usageTotal1: string;
	readonly usageTotal2: string;
}

/* Every statement is PostgreSQL; the platform has no second dialect. */
export const AGENTS_SQL: AgentsPersistenceStatements = Object.freeze({
	procedureIds: `SELECT skill_id FROM agent_skill_assignments
					 WHERE tenant_id = $1 AND agent_id = $2 ORDER BY skill_id`,
	procedureSnapshots: `SELECT * FROM agent_run_skill_snapshots
					 WHERE tenant_id = $1 AND run_id = $2 ORDER BY skill_key, skill_id`,
	setAgentSkills1: `DELETE FROM agent_skill_assignments WHERE agent_id = $1`,
	setAgentSkills2: `INSERT INTO agent_skill_assignments (agent_id, skill_id, tenant_id)
			 VALUES ($1, $2, $3)`,
	revisionSkills: `SELECT agent_skills.id, agent_skills.skill_key, agent_skills.name,
					 agent_skills.revision, agent_skills.instructions,
					 agent_skills.required_tools_json
					 FROM agent_skill_assignments JOIN agent_skills
					  ON agent_skills.id = agent_skill_assignments.skill_id
					 AND agent_skills.tenant_id = agent_skill_assignments.tenant_id
					 WHERE agent_skill_assignments.tenant_id = $1
					  AND agent_skill_assignments.agent_id = $2
					 ORDER BY agent_skills.skill_key, agent_skills.id`,
	retainAgentRevision1: `INSERT INTO agent_definition_revisions
				 (tenant_id, agent_id, revision, agent_key, name, description,
				  instructions, provider, model, allowed_tools_json, skills_json,
				  max_steps, timeout_ms, temperature_milli, max_output_tokens,
				  status, retained_by, retained_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
				 ON CONFLICT DO NOTHING`,
	retainAgentRevision2: `INSERT INTO agent_definition_revisions
				 (tenant_id, agent_id, revision, agent_key, name, description,
				  instructions, provider, model, allowed_tools_json, skills_json,
				  max_steps, timeout_ms, temperature_milli, max_output_tokens,
				  status, retained_by, retained_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
	listAgentsForRevisionAdoption: `${AGENT_SELECT}
					 WHERE agent_definitions.tenant_id = $1
					 ORDER BY agent_definitions.tenant_id, agent_definitions.id`,
	retainModuleAgentRevision1: `INSERT INTO agent_definition_revisions
				 (tenant_id, agent_id, revision, agent_key, name, description,
				  instructions, provider, model, allowed_tools_json, skills_json,
				  max_steps, timeout_ms, temperature_milli, max_output_tokens,
				  status, retained_by, retained_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]', $11, $12, $13, $14, 'active', $15, $16)`,
	retainModuleAgentRevision2: `INSERT INTO agent_revision_ownership
				 (tenant_id, agent_id, revision, module_id, module_definition_revision)
				 VALUES ($1, $2, $3, $4, $5)`,
	reconcileModuleAgents1: `SELECT * FROM module_agent_definitions WHERE agent_id = $1`,
	reconcileModuleAgents2: `INSERT INTO agent_definitions
							 (id, tenant_id, agent_key, name, description, instructions,
							  provider, model, allowed_tools_json, max_steps, timeout_ms,
							  temperature_milli, status, revision, created_by, created_at,
							  updated_by, updated_at)
							 VALUES ($1, '__flowdular_module_agents__', $2, $3, $4, $5,
							  'local-simulation', 'deterministic-v1', $6, $7, $8, $9, 'archived',
							  $10, $11, $12, $13, $14)`,
	reconcileModuleAgents3: `UPDATE agent_definitions SET name = $1, description = $2,
							 instructions = $3, allowed_tools_json = $4, max_steps = $5,
							 timeout_ms = $6, temperature_milli = $7, revision = $8,
							 updated_by = $9, updated_at = $10 WHERE id = $11`,
	reconcileModuleAgents4: `INSERT INTO module_agent_definitions
						 (agent_id, module_id, agent_key, definition_revision, content_hash,
						  name, description, instructions, allowed_tools_json, max_steps,
						  timeout_ms, temperature_milli, max_output_tokens, registered_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
						 ON CONFLICT(agent_id) DO UPDATE SET
						  definition_revision = excluded.definition_revision,
						  content_hash = excluded.content_hash, name = excluded.name,
						  description = excluded.description, instructions = excluded.instructions,
						  allowed_tools_json = excluded.allowed_tools_json,
						  max_steps = excluded.max_steps, timeout_ms = excluded.timeout_ms,
						  temperature_milli = excluded.temperature_milli,
						  max_output_tokens = excluded.max_output_tokens,
						  registered_at = excluded.registered_at`,
	reconcileModuleAgents5: `SELECT * FROM module_agent_bindings WHERE agent_id = $1`,
	reconcileModuleAgents6: `UPDATE module_agent_bindings SET enabled_tools_json = $1,
								 module_definition_revision = $2, executable_revision = $3,
								 revision = $4, updated_by = $5, updated_at = $6
								 WHERE tenant_id = $7 AND agent_id = $8`,
	listModuleAgentBindings: `SELECT * FROM module_agent_bindings WHERE tenant_id = $1
					 ORDER BY agent_id`,
	getModuleAgentBinding: `SELECT * FROM module_agent_bindings WHERE tenant_id = $1 AND agent_id = $2`,
	saveModuleAgentBinding1: `INSERT INTO module_agent_bindings
						 (tenant_id, agent_id, provider, model, enabled_tools_json, status,
						  module_definition_revision, executable_revision, revision,
						  updated_by, updated_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
	saveModuleAgentBinding2: `UPDATE module_agent_bindings SET provider = $1, model = $2,
						 enabled_tools_json = $3, status = $4, module_definition_revision = $5,
						 executable_revision = $6, revision = $7, updated_by = $8, updated_at = $9
						 WHERE tenant_id = $10 AND agent_id = $11 AND revision = $12`,
	saveModuleAgentBinding3: `SELECT 1 FROM agent_definition_revisions
					 WHERE tenant_id = $1 AND agent_id = $2 AND revision = $3`,
	listAgents: `${AGENT_SELECT} WHERE agent_definitions.tenant_id = $1
					 ORDER BY lower(agent_definitions.name), agent_definitions.id`,
	providerUsage1: `SELECT
				  (SELECT COUNT(*) FROM agent_definitions
				   WHERE tenant_id = $1 AND provider = $2 AND status <> 'archived') +
				  (SELECT COUNT(*) FROM module_agent_bindings
				   WHERE tenant_id = $3 AND provider = $4) AS count`,
	providerUsage2: `SELECT COUNT(*) AS count FROM agent_runs
				 WHERE tenant_id = $1 AND provider = $2 AND status IN ('queued', 'running')`,
	agentUsage: `SELECT
				  (SELECT COUNT(*) FROM agent_runs
				   WHERE tenant_id = $1 AND agent_id = $2) AS runs,
				  (SELECT COUNT(*) FROM agent_runs
				   WHERE tenant_id = $3 AND agent_id = $4
				     AND status IN ('queued', 'running')) AS pending_runs,
				  (SELECT COUNT(*) FROM agent_skill_assignments
				   WHERE tenant_id = $5 AND agent_id = $6) AS assignments`,
	getAgent: `${AGENT_SELECT} WHERE agent_definitions.tenant_id = $1
					 AND agent_definitions.id = $2`,
	getAgentRevision: `${AGENT_REVISION_SELECT}
				 WHERE agent_definition_revisions.tenant_id = $1
				  AND agent_definition_revisions.agent_id = $2
				  AND agent_definition_revisions.revision = $3`,
	listAgentRevisions: `${AGENT_REVISION_SELECT}
					 WHERE agent_definition_revisions.tenant_id = $1
					 ORDER BY lower(agent_definition_revisions.name),
					  agent_definition_revisions.agent_id,
					  agent_definition_revisions.revision DESC`,
	createAgent1: `INSERT INTO agent_definitions
					 (id, tenant_id, agent_key, name, description, instructions,
					  provider, model, allowed_tools_json, max_steps, timeout_ms,
					  temperature_milli, status, revision, created_by, created_at,
					  updated_by, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
	createAgent2: `INSERT INTO agent_definition_execution_limits
					 (agent_id, tenant_id, timeout_ms) VALUES ($1, $2, $3)`,
	createAgent3: `INSERT INTO agent_definition_output_limits
					 (agent_id, tenant_id, max_output_tokens) VALUES ($1, $2, $3)`,
	updateAgent1: `UPDATE agent_definitions SET agent_key = $1, name = $2,
					 description = $3, instructions = $4, provider = $5, model = $6,
					 allowed_tools_json = $7, max_steps = $8, timeout_ms = $9,
					 temperature_milli = $10, status = $11, revision = $12, updated_by = $13,
					 updated_at = $14 WHERE tenant_id = $15 AND id = $16`,
	updateAgent2: `INSERT INTO agent_definition_execution_limits
					 (agent_id, tenant_id, timeout_ms) VALUES ($1, $2, $3)
					 ON CONFLICT(agent_id) DO UPDATE SET timeout_ms = excluded.timeout_ms`,
	updateAgent3: `INSERT INTO agent_definition_output_limits
					 (agent_id, tenant_id, max_output_tokens) VALUES ($1, $2, $3)
					 ON CONFLICT(agent_id) DO UPDATE SET max_output_tokens = excluded.max_output_tokens`,
	deleteAgent: `DELETE FROM agent_definitions WHERE tenant_id = $1 AND id = $2`,
	listProcedures: `SELECT * FROM agent_skills WHERE tenant_id = $1
					 ORDER BY lower(name), id`,
	getProcedure: `SELECT * FROM agent_skills WHERE tenant_id = $1 AND id = $2`,
	createProcedure: `INSERT INTO agent_skills
					 (id, tenant_id, skill_key, name, description, instructions,
					  required_tools_json, status, revision, created_by, created_at,
					  updated_by, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
	updateProcedure: `UPDATE agent_skills SET skill_key = $1, name = $2, description = $3,
					 instructions = $4, required_tools_json = $5, status = $6, revision = $7,
					 updated_by = $8, updated_at = $9 WHERE tenant_id = $10 AND id = $11`,
	procedureUsage: `SELECT COUNT(*) AS assignments,
				 SUM(CASE WHEN agent_definitions.status = 'active' THEN 1 ELSE 0 END) AS active_definitions
				 FROM agent_skill_assignments
				 JOIN agent_definitions
				   ON agent_definitions.id = agent_skill_assignments.agent_id
				  AND agent_definitions.tenant_id = agent_skill_assignments.tenant_id
				 WHERE agent_skill_assignments.tenant_id = $1
				   AND agent_skill_assignments.skill_id = $2`,
	deleteProcedure: `DELETE FROM agent_skills WHERE tenant_id = $1 AND id = $2`,
	listRuns: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = $1
					 ORDER BY queued_at DESC, agent_runs.id DESC LIMIT $2`,
	getRun: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = $1 AND agent_runs.id = $2`,
	listRunEvents: `SELECT sequence, event_type, message, metadata_json, occurred_at
					 FROM agent_run_events WHERE tenant_id = $1 AND run_id = $2
					 AND sequence > $3 ORDER BY sequence`,
	findRunByIdempotencyKey: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM}
				 WHERE agent_runs.tenant_id = $1 AND idempotency_key = $2`,
	enqueueRun1: `INSERT INTO agent_runs
				 (id, tenant_id, agent_id, agent_name, agent_revision,
				  instructions_snapshot, provider, model, allowed_tools_json,
				  max_steps, timeout_ms, temperature_milli, trigger, status, input,
				  output, requested_by, permission_snapshot_json, tool_grants_json,
				  usage_json, failure_code, failure_message, idempotency_key, attempt,
				  queued_at, started_at, completed_at, lease_owner, lease_expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'queued', $14, NULL,
				  $15, $16, $17, NULL, NULL, NULL, $18, 0, $19, NULL, NULL, NULL, NULL)`,
	enqueueRun2: `INSERT INTO agent_run_execution_limits (run_id, tenant_id, timeout_ms)
			 VALUES ($1, $2, $3)`,
	enqueueRun3: `INSERT INTO agent_run_output_limits (run_id, tenant_id, max_output_tokens)
			 VALUES ($1, $2, $3)`,
	enqueueRun4: `INSERT INTO agent_run_skill_snapshots
			 (run_id, tenant_id, skill_id, skill_key, skill_name, skill_revision,
			  required_tools_json)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
	enqueueRun5: `INSERT INTO agent_run_contracts
					 (run_id, tenant_id, workflow_run_id, output_contract_json,
					  structured_output_json, request_hash)
					 VALUES ($1, $2, $3, $4, NULL, $5)`,
	enqueueRun6: `INSERT INTO agent_run_actors
					 (run_id, tenant_id, actor_json, authorization_subject_json)
					 VALUES ($1, $2, $3, $4)`,
	listRecoverableRuns: `SELECT tenant_id, id FROM agent_runs
					 WHERE status = 'queued'
					    OR (status = 'running' AND lease_expires_at < $1)
					 ORDER BY queued_at, id LIMIT $2`,
	claimRun1: `UPDATE agent_runs SET status = 'running', lease_owner = $1,
					 lease_expires_at = $2, started_at = COALESCE(started_at, $3),
					 attempt = attempt + 1
					 WHERE tenant_id = $4 AND id = $5 AND
					 (status = 'queued' OR (status = 'running' AND lease_expires_at < $6))`,
	claimRun2: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM} WHERE agent_runs.tenant_id = $1 AND agent_runs.id = $2`,
	renewLease: `UPDATE agent_runs SET lease_expires_at = $1 WHERE tenant_id = $2
					 AND id = $3 AND status = 'running' AND lease_owner = $4`,
	consumeRunGrant1: `DELETE FROM agent_run_grant_uses WHERE expires_at < $1`,
	consumeRunGrant2: `INSERT INTO agent_run_grant_uses
				 (grant_id, token_hash, tenant_id, run_id, worker_id, provider_id,
				  model_id, issued_at, expires_at, consumed_at)
				 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
				 FROM agent_runs
				 WHERE tenant_id = $11 AND id = $12 AND status = 'running'
				   AND lease_owner = $13 AND lease_expires_at >= $14
				 ON CONFLICT DO NOTHING`,
	appendRunEvent: `INSERT INTO agent_run_events
				 (run_id, tenant_id, sequence, event_type, message, metadata_json,
				  occurred_at)
				 SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1, $3, $4, $5, $6
				 FROM agent_run_events WHERE run_id = $7 AND tenant_id = $8`,
	completeRun1: `UPDATE agent_runs SET status = 'succeeded', output = $1, usage_json = $2,
					 completed_at = $3, lease_owner = NULL, lease_expires_at = NULL
					 WHERE tenant_id = $4 AND id = $5 AND status = 'running'
					 AND lease_owner = $6`,
	completeRun2: `UPDATE agent_run_contracts SET structured_output_json = $1
					 WHERE tenant_id = $2 AND run_id = $3`,
	completeRun3: `SELECT agent_id, agent_name, model FROM agent_runs
					 WHERE tenant_id = $1 AND id = $2`,
	completeRun4: `INSERT INTO agent_run_costs
					 (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
					  output_tokens, cost_micro_usd, completed_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
					 ON CONFLICT(run_id) DO UPDATE SET
					  input_tokens = excluded.input_tokens,
					  output_tokens = excluded.output_tokens,
					  cost_micro_usd = excluded.cost_micro_usd,
					  day = excluded.day, completed_at = excluded.completed_at`,
	failRun: `UPDATE agent_runs SET status = 'failed', failure_code = $1,
					 failure_message = $2, completed_at = $3, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = $4 AND id = $5
					 AND status = 'running' AND lease_owner = $6`,
	cancelRun1: `SELECT status FROM agent_runs WHERE tenant_id = $1 AND id = $2`,
	cancelRun2: `UPDATE agent_runs SET status = 'cancelled', failure_code = 'RUN_CANCELLED',
					 failure_message = $1, completed_at = $2, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = $3 AND id = $4`,
	enqueueAction: `INSERT INTO agent_action_invocations
					 (id, tenant_id, workflow_run_id, node_run_id, action_id,
					  contract_version, actor_json, authorization_subject_json, permission_snapshot_json,
					  input_json, idempotency_key, request_hash, status, output_json,
					  failure_code, attempt, queued_at, started_at, completed_at,
					  lease_owner, lease_expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued', NULL, NULL,
					  0, $13, NULL, NULL, NULL, NULL)`,
	getAction: `SELECT * FROM agent_action_invocations
				 WHERE tenant_id = $1 AND id = $2`,
	findActionByIdempotencyKey: `SELECT * FROM agent_action_invocations
				 WHERE tenant_id = $1 AND idempotency_key = $2`,
	listRecoverableActions: `SELECT tenant_id, id FROM agent_action_invocations
					 WHERE status = 'queued'
					 OR (status = 'running' AND lease_expires_at < $1)
					 ORDER BY queued_at, id LIMIT $2`,
	claimAction: `UPDATE agent_action_invocations SET status = 'running',
					 lease_owner = $1, lease_expires_at = $2,
					 started_at = COALESCE(started_at, $3), attempt = attempt + 1
					 WHERE tenant_id = $4 AND id = $5
					 AND (status = 'queued' OR
					  (status = 'running' AND lease_expires_at < $6))`,
	renewActionLease: `UPDATE agent_action_invocations SET lease_expires_at = $1
					 WHERE tenant_id = $2 AND id = $3 AND status = 'running'
					 AND lease_owner = $4`,
	completeAction: `UPDATE agent_action_invocations SET status = 'succeeded',
					 output_json = $1, completed_at = $2, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = $3 AND id = $4
					 AND status = 'running' AND lease_owner = $5`,
	failAction: `UPDATE agent_action_invocations SET status = 'failed',
					 failure_code = $1, completed_at = $2, lease_owner = NULL,
					 lease_expires_at = NULL WHERE tenant_id = $3 AND id = $4
					 AND status = 'running' AND lease_owner = $5`,
	cancelAction: `UPDATE agent_action_invocations SET status = 'cancelled',
					 failure_code = 'ACTION_CANCELLED', completed_at = $1,
					 lease_owner = NULL, lease_expires_at = NULL
					 WHERE tenant_id = $2 AND id = $3 AND status IN ('queued', 'running')`,
	appendAuditEvent1: `SELECT sequence, event_hash FROM agent_audit_events_v4
					 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
	appendAuditEvent2: `INSERT INTO agent_audit_events_v4
					 (id, tenant_id, sequence, actor_id, action, subject_type,
					  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
	/* The order agent_runs_tenant_queued_idx already carries, so the walk is an
	   index range scan and a run queued during it lands ahead of the cursor
	   rather than being visited twice. */
	exportRunsPage1: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM}
					 WHERE agent_runs.tenant_id = $1
					 ORDER BY queued_at DESC, agent_runs.id LIMIT $2`,
	exportRunsPage2: `SELECT ${RUN_COLUMNS} FROM ${RUN_FROM}
					 WHERE agent_runs.tenant_id = $1
					 AND (queued_at < $2 OR (queued_at = $3 AND agent_runs.id > $4))
					 ORDER BY queued_at DESC, agent_runs.id LIMIT $5`,
	exportRunEvents: `SELECT run_id, sequence, event_type, message, metadata_json,
					 occurred_at FROM agent_run_events
					 WHERE tenant_id = $1 AND run_id = ANY($2::text[])
					 ORDER BY run_id, sequence`,
	/* The inner select applies the batch limit; the child tables of a run go
	   with it through their own cascade. */
	deleteSettledRunsBefore: `DELETE FROM agent_runs WHERE id IN (
					 SELECT id FROM agent_runs
					 WHERE tenant_id = $1 AND completed_at < $2
					  AND status IN ('succeeded', 'failed', 'cancelled')
					 ORDER BY completed_at LIMIT $3)`,
	deleteRunsRequestedBy: `DELETE FROM agent_runs WHERE id IN (
					 SELECT id FROM agent_runs
					 WHERE tenant_id = $1 AND requested_by = $2
					 ORDER BY id LIMIT $3)`,
	pruneMeterRefusals: `DELETE FROM agent_meter_refusals
					 WHERE tenant_id = $1 AND meter = $2 AND period <> $3`,
	claimMeterRefusal: `INSERT INTO agent_meter_refusals
					 (tenant_id, meter, period, first_refused_at)
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT (tenant_id, meter, period) DO NOTHING
					 RETURNING tenant_id`,
	listAuditEvents: `SELECT * FROM agent_audit_events_v4 WHERE tenant_id = $1
					 ORDER BY sequence DESC LIMIT $2`,
	exportAuditEventsPage: `SELECT * FROM agent_audit_events_v4
					 WHERE tenant_id = $1 AND sequence > $2
					 ORDER BY sequence LIMIT $3`,
	pageAuditEvents1: `SELECT * FROM agent_audit_events_v4 WHERE tenant_id = $1
							 AND (occurred_at < $2 OR (occurred_at = $3 AND sequence < $4))
							 ORDER BY occurred_at DESC, sequence DESC LIMIT $5`,
	pageAuditEvents2: `SELECT * FROM agent_audit_events_v4 WHERE tenant_id = $1
							 ORDER BY occurred_at DESC, sequence DESC LIMIT $2`,
	verifyAuditChainDetailed: `SELECT * FROM agent_audit_events_v4 WHERE tenant_id = $1
					 ORDER BY sequence`,
	usageByDay: `SELECT day, ${USAGE_COLUMNS} FROM agent_run_costs
					 WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
					 GROUP BY day ORDER BY day`,
	usageByAgent: `SELECT agent_id, MAX(agent_name) AS agent_name, ${USAGE_COLUMNS}
					 FROM agent_run_costs WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
					 GROUP BY agent_id ORDER BY cost_micro_usd DESC, agent_id`,
	usageTotal1: `SELECT ${USAGE_COLUMNS} FROM agent_run_costs
							 WHERE tenant_id = $1 AND day >= $2`,
	usageTotal2: `SELECT ${USAGE_COLUMNS} FROM agent_run_costs
							 WHERE tenant_id = $1 AND agent_id = $2 AND day >= $3`,
});

export async function migrateAgentsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'agents.core', databaseMigrations);
}

export interface AgentsDatabaseHandles {
	/** Tenant-scoped handle used by every request-time read and write. */
	readonly runtime: DatabaseHandle;
	/**
	 * Cross-tenant read handle for the worker recovery polls. It reads only what
	 * those tables' own FOR SELECT policy grants and writes nothing; the claim
	 * that follows runs under the tenant of the row it returned.
	 */
	readonly background: DatabaseHandle;
}

/** A dialect-neutral repository over platform-owned database handles. */
export class DatabaseAgentRepository implements AgentRepository {
	constructor(
		private readonly handles: AgentsDatabaseHandles,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	/* One unit of work under one tenant. Every multi-statement operation runs
	   inside a single transaction, so a partially written run is impossible. */
	async #tx<T>(
		tenantId: string,
		access: 'read' | 'write',
		body: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return this.handles.runtime.transaction(body, { access, tenantId });
	}

	/* The recovery polls have to find work before they know whose it is. They
	   read routing columns on the read-only background handle; the claim that
	   follows runs under the tenant the row named. */
	async #crossTenant<T>(
		body: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return this.handles.background.transaction(body, { access: 'read' });
	}

	async #query<Row extends object>(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<readonly Row[]> {
		const result = await transaction.query<Row>({
			text,
			parameters: parameters as never,
		});
		return result.rows;
	}

	async #exec(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<number> {
		const result = await transaction.execute({
			text,
			parameters: parameters as never,
		});
		return result.affectedRows;
	}

	async #procedureIds(
		transaction: DatabaseTransaction,
		tenantId: string,
		agentId: string,
	): Promise<readonly string[]> {
		return (
			(await this.#query(transaction, AGENTS_SQL.procedureIds, [
				tenantId,
				agentId,
			])) as unknown as { skill_id: string }[]
		).map((row) => row.skill_id);
	}

	async #procedureSnapshots(
		transaction: DatabaseTransaction,
		tenantId: string,
		runId: string,
	): Promise<readonly AgentProcedureSnapshot[]> {
		return (
			(await this.#query(transaction, AGENTS_SQL.procedureSnapshots, [
				tenantId,
				runId,
			])) as unknown as SkillSnapshotRow[]
		).map((row) => ({
			id: row.skill_id,
			key: row.skill_key,
			name: row.skill_name,
			revision: row.skill_revision,
			requiredTools: stringArray(row.required_tools_json),
		}));
	}

	async #setAgentSkills(
		transaction: DatabaseTransaction,
		agent: AgentDefinition,
	): Promise<void> {
		await this.#exec(transaction, AGENTS_SQL.setAgentSkills1, [agent.id]);
		for (const procedureId of agent.procedureIds) {
			await this.#exec(transaction, AGENTS_SQL.setAgentSkills2, [
				agent.id,
				procedureId,
				agent.tenantId,
			]);
		}
	}

	async #revisionSkills(
		transaction: DatabaseTransaction,

		tenantId: string,
		agentId: string,
	): Promise<readonly AgentRevisionProcedure[]> {
		return (
			(await this.#query(transaction, AGENTS_SQL.revisionSkills, [
				tenantId,
				agentId,
			])) as unknown as {
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

	async #retainAgentRevision(
		transaction: DatabaseTransaction,
		agent: AgentDefinition,
		ignoreExisting = false,
	): Promise<void> {
		await this.#exec(
			transaction,
			ignoreExisting
				? AGENTS_SQL.retainAgentRevision1
				: AGENTS_SQL.retainAgentRevision2,
			[
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
				JSON.stringify(
					await this.#revisionSkills(transaction, agent.tenantId, agent.id),
				),
				agent.maxSteps,
				agent.timeoutMs,
				Math.round(agent.temperature * 1_000),
				agent.maxOutputTokens,
				agent.status,
				agent.updatedBy,
				agent.updatedAt,
			],
		);
	}

	async adoptCurrentAgentRevisions(): Promise<void> {
		let afterTenant = '';
		for (;;) {
			const page = await this.#crossTenant((transaction) =>
				this.#query<{ tenant_id: string }>(
					transaction,
					`SELECT DISTINCT tenant_id FROM agent_definitions
				 WHERE tenant_id > $1 AND tenant_id <> '__flowdular_module_agents__'
				 ORDER BY tenant_id LIMIT 100`,
					[afterTenant],
				),
			);
			if (page.length === 0) return;
			for (const { tenant_id: tenantId } of page)
				await this.#tx(tenantId, 'write', async (transaction) => {
					for (const agent of await this.#agentsForRevisionAdoption(
						transaction,
						tenantId,
					)) {
						await this.#retainAgentRevision(transaction, agent, true);
					}
				});
			afterTenant = page[page.length - 1]!.tenant_id;
		}
	}

	/* Constructor-only helper. It avoids calling a public method while the
	   repository is still adopting the pre-ledger current definitions. */
	async #agentsForRevisionAdoption(
		transaction: DatabaseTransaction,
		tenantId: string,
	): Promise<readonly AgentDefinition[]> {
		const rows = (await this.#query(
			transaction,
			AGENTS_SQL.listAgentsForRevisionAdoption,
			[tenantId],
		)) as unknown as AgentRow[];
		const agents: AgentDefinition[] = [];
		for (const row of rows) {
			const agent = fromAgentRow(row);
			agents.push({
				...agent,
				procedureIds: await this.#procedureIds(
					transaction,
					agent.tenantId,
					agent.id,
				),
			});
		}
		return agents;
	}

	async #retainModuleAgentRevision(
		transaction: DatabaseTransaction,

		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
	): Promise<void> {
		await this.#exec(transaction, AGENTS_SQL.retainModuleAgentRevision1, [
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
		]);
		await this.#exec(transaction, AGENTS_SQL.retainModuleAgentRevision2, [
			binding.tenantId,
			definition.id,
			binding.executableRevision,
			definition.moduleId,
			definition.definitionRevision,
		]);
	}

	async reconcileModuleAgents(
		definitions: readonly ModuleAgentDefinition[],
		reconciledAt: number,
	): Promise<void> {
		await this.#tx(
			'__flowdular_module_agents__',
			'write',
			async (transaction) => {
				await transaction.query({
					text: "SELECT pg_advisory_xact_lock(hashtextextended('agents.core.module-catalog', 0))",
				});
				try {
					const seen = new Set<string>();
					for (const definition of definitions) {
						if (seen.has(definition.id)) {
							throw new Error(`MODULE_AGENT_DUPLICATE: ${definition.id}`);
						}
						seen.add(definition.id);
						const contentHash = moduleAgentDefinitionHash(definition);
						const stored = (
							await this.#query(
								transaction,
								AGENTS_SQL.reconcileModuleAgents1,
								[definition.id],
							)
						)[0] as unknown as ModuleAgentDefinitionRow | undefined;
						if (stored) {
							if (definition.definitionRevision < stored.definition_revision) {
								throw new Error(
									`MODULE_AGENT_REVISION_DOWNGRADE: ${definition.id} registered revision ${definition.definitionRevision} after ${stored.definition_revision}.`,
								);
							}
							if (
								definition.definitionRevision === stored.definition_revision
							) {
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
							await this.#exec(transaction, AGENTS_SQL.reconcileModuleAgents2, [
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
							]);
						}

						if (stored) {
							await this.#exec(transaction, AGENTS_SQL.reconcileModuleAgents3, [
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
							]);
						}

						await this.#exec(transaction, AGENTS_SQL.reconcileModuleAgents4, [
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
						]);
					}
				} catch (error) {
					throw error;
				}
			},
		);
		// Retry stale bindings even when the durable catalog already has this revision.
		for (const definition of definitions)
			await this.#reconcileModuleBindings(definition, reconciledAt);
	}

	async #reconcileModuleBindings(
		definition: ModuleAgentDefinition,
		reconciledAt: number,
	): Promise<void> {
		let afterTenant = '';
		for (;;) {
			const page = await this.#crossTenant((transaction) =>
				this.#query<{ tenant_id: string }>(
					transaction,
					'SELECT tenant_id FROM module_agent_bindings WHERE agent_id = $1 AND tenant_id > $2 ORDER BY tenant_id LIMIT 100',
					[definition.id, afterTenant],
				),
			);
			if (page.length === 0) return;
			for (const { tenant_id: tenantId } of page)
				await this.#tx(tenantId, 'write', async (transaction) => {
					const catalog = (
						await this.#query<ModuleAgentDefinitionRow>(
							transaction,
							AGENTS_SQL.reconcileModuleAgents1 + ' FOR SHARE',
							[definition.id],
						)
					)[0];
					if (
						catalog?.definition_revision !== definition.definitionRevision ||
						catalog.content_hash !== moduleAgentDefinitionHash(definition)
					) {
						throw new Error(
							'MODULE_AGENT_REVISION_DRIFT: catalog changed during reconciliation.',
						);
					}
					const row = (
						await this.#query<ModuleAgentBindingRow>(
							transaction,
							AGENTS_SQL.getModuleAgentBinding + ' FOR UPDATE',
							[tenantId, definition.id],
						)
					)[0];
					if (
						!row ||
						row.module_definition_revision >= definition.definitionRevision
					)
						return;
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
					await this.#exec(transaction, AGENTS_SQL.reconcileModuleAgents6, [
						JSON.stringify(binding.enabledTools),
						binding.moduleDefinitionRevision,
						binding.executableRevision,
						binding.revision,
						binding.updatedBy,
						binding.updatedAt,
						binding.tenantId,
						binding.agentId,
					]);
					await this.#retainModuleAgentRevision(
						transaction,
						binding,
						definition,
					);
					await this.#appendAuditEvent(transaction, {
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
				});
			afterTenant = page[page.length - 1]!.tenant_id;
		}
	}

	async listModuleAgentBindings(
		tenantId: string,
	): Promise<readonly ModuleAgentBinding[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.listModuleAgentBindings, [
					tenantId,
				])) as unknown as ModuleAgentBindingRow[]
			).map(fromModuleBindingRow);
		});
	}

	async getModuleAgentBinding(
		tenantId: string,
		agentId: string,
	): Promise<ModuleAgentBinding | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.getModuleAgentBinding, [
					tenantId,
					agentId,
				])
			)[0] as unknown as ModuleAgentBindingRow | undefined;
			return row ? fromModuleBindingRow(row) : null;
		});
	}

	async saveModuleAgentBinding(
		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
		expectedRevision: number,
		audit: PendingAgentAuditEvent,
	): Promise<ModuleAgentBinding> {
		return this.#tx(binding.tenantId, 'write', async (transaction) => {
			try {
				if (expectedRevision === 0) {
					await this.#exec(transaction, AGENTS_SQL.saveModuleAgentBinding1, [
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
					]);
				} else {
					const result = await this.#exec(
						transaction,
						AGENTS_SQL.saveModuleAgentBinding2,
						[
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
						],
					);
					if (result !== 1) throw new ModuleAgentBindingConflictError();
				}
				const existingRevision = (
					await this.#query(transaction, AGENTS_SQL.saveModuleAgentBinding3, [
						binding.tenantId,
						binding.agentId,
						binding.executableRevision,
					])
				)[0];
				if (!existingRevision)
					await this.#retainModuleAgentRevision(
						transaction,
						binding,
						definition,
					);
				await this.#appendAuditEvent(transaction, audit);
			} catch (error) {
				if (
					expectedRevision === 0 &&
					String(error).includes('module_agent_bindings_pkey')
				) {
					throw new ModuleAgentBindingConflictError();
				}
				throw error;
			}
			return binding;
		});
	}

	async listAgents(tenantId: string): Promise<readonly AgentDefinition[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const rows = (await this.#query(transaction, AGENTS_SQL.listAgents, [
				tenantId,
			])) as unknown as AgentRow[];
			const agents: AgentDefinition[] = [];
			for (const row of rows) {
				const agent = fromAgentRow(row);
				agents.push({
					...agent,
					procedureIds: await this.#procedureIds(
						transaction,
						agent.tenantId,
						agent.id,
					),
				});
			}
			return agents;
		});
	}

	providerUsage(
		tenantId: string,
		providerId: string,
	): Promise<{ readonly definitions: number; readonly pendingRuns: number }> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const definitions = (
				await this.#query(transaction, AGENTS_SQL.providerUsage1, [
					tenantId,
					providerId,
					tenantId,
					providerId,
				])
			)[0] as unknown as { count: number | string };
			const pendingRuns = (
				await this.#query(transaction, AGENTS_SQL.providerUsage2, [
					tenantId,
					providerId,
				])
			)[0] as unknown as { count: number | string };
			return {
				definitions: integer(definitions.count),
				pendingRuns: integer(pendingRuns.count),
			};
		});
	}

	agentUsage(
		tenantId: string,
		agentId: string,
	): Promise<{
		readonly runs: number;
		readonly pendingRuns: number;
		readonly assignments: number;
	}> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const counts = (
				await this.#query(transaction, AGENTS_SQL.agentUsage, [
					tenantId,
					agentId,
					tenantId,
					agentId,
					tenantId,
					agentId,
				])
			)[0] as unknown as {
				runs: number;
				pending_runs: number;
				assignments: number;
			};
			return {
				runs: counts.runs,
				pendingRuns: counts.pending_runs,
				assignments: counts.assignments,
			};
		});
	}

	async getAgent(
		tenantId: string,
		agentId: string,
	): Promise<AgentDefinition | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.getAgent, [tenantId, agentId])
			)[0] as unknown as AgentRow | undefined;
			if (!row) return null;
			const agent = fromAgentRow(row);
			return {
				...agent,
				procedureIds: await this.#procedureIds(
					transaction,
					agent.tenantId,
					agent.id,
				),
			};
		});
	}

	async getAgentRevision(
		tenantId: string,
		agentId: string,
		revision: number,
	): Promise<AgentDefinitionRevision | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.getAgentRevision, [
					tenantId,
					agentId,
					revision,
				])
			)[0] as unknown as AgentRevisionRow | undefined;
			return row ? fromRevisionRow(row) : null;
		});
	}

	async listAgentRevisions(
		tenantId: string,
	): Promise<readonly AgentDefinitionRevision[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.listAgentRevisions, [
					tenantId,
				])) as unknown as AgentRevisionRow[]
			).map(fromRevisionRow);
		});
	}

	async createAgent(agent: AgentDefinition): Promise<AgentDefinition> {
		return this.#tx(agent.tenantId, 'write', async (transaction) => {
			try {
				await this.#exec(transaction, AGENTS_SQL.createAgent1, [
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
				]);
				await this.#exec(transaction, AGENTS_SQL.createAgent2, [
					agent.id,
					agent.tenantId,
					agent.timeoutMs,
				]);
				await this.#exec(transaction, AGENTS_SQL.createAgent3, [
					agent.id,
					agent.tenantId,
					agent.maxOutputTokens,
				]);
				await this.#setAgentSkills(transaction, agent);
				await this.#retainAgentRevision(transaction, agent);
			} catch (error) {
				if (
					String(error).includes('agent_definitions_tenant_id_agent_key_key')
				) {
					throw new DuplicateAgentKeyError();
				}
				throw error;
			}
			return agent;
		});
	}

	async updateAgent(agent: AgentDefinition): Promise<AgentDefinition> {
		return this.#tx(agent.tenantId, 'write', async (transaction) => {
			try {
				const result = await this.#exec(transaction, AGENTS_SQL.updateAgent1, [
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
				]);
				if (result !== 1) throw new Error('Agent definition not found.');
				await this.#exec(transaction, AGENTS_SQL.updateAgent2, [
					agent.id,
					agent.tenantId,
					agent.timeoutMs,
				]);
				await this.#exec(transaction, AGENTS_SQL.updateAgent3, [
					agent.id,
					agent.tenantId,
					agent.maxOutputTokens,
				]);
				await this.#setAgentSkills(transaction, agent);
				await this.#retainAgentRevision(transaction, agent);
			} catch (error) {
				if (
					String(error).includes('agent_definitions_tenant_id_agent_key_key')
				) {
					throw new DuplicateAgentKeyError();
				}
				throw error;
			}
			return agent;
		});
	}

	async deleteAgent(tenantId: string, agentId: string): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			return (
				(await this.#exec(transaction, AGENTS_SQL.deleteAgent, [
					tenantId,
					agentId,
				])) === 1
			);
		});
	}

	async listProcedures(tenantId: string): Promise<readonly AgentProcedure[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.listProcedures, [
					tenantId,
				])) as unknown as SkillRow[]
			).map(fromSkillRow);
		});
	}

	async getProcedure(
		tenantId: string,
		skillId: string,
	): Promise<AgentProcedure | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.getProcedure, [
					tenantId,
					skillId,
				])
			)[0] as unknown as SkillRow | undefined;
			return row ? fromSkillRow(row) : null;
		});
	}

	async createProcedure(skill: AgentProcedure): Promise<AgentProcedure> {
		return this.#tx(skill.tenantId, 'write', async (transaction) => {
			try {
				await this.#exec(transaction, AGENTS_SQL.createProcedure, [
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
				]);
			} catch (error) {
				if (String(error).includes('agent_skills_tenant_id_skill_key_key')) {
					throw new DuplicateAgentProcedureKeyError();
				}
				throw error;
			}
			return skill;
		});
	}

	async updateProcedure(skill: AgentProcedure): Promise<AgentProcedure> {
		return this.#tx(skill.tenantId, 'write', async (transaction) => {
			try {
				const result = await this.#exec(
					transaction,
					AGENTS_SQL.updateProcedure,
					[
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
					],
				);
				if (result !== 1) throw new Error('Agent skill not found.');
			} catch (error) {
				if (String(error).includes('agent_skills_tenant_id_skill_key_key')) {
					throw new DuplicateAgentProcedureKeyError();
				}
				throw error;
			}
			return skill;
		});
	}

	procedureUsage(
		tenantId: string,
		skillId: string,
	): Promise<{
		readonly assignments: number;
		readonly activeDefinitions: number;
	}> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const counts = (
				await this.#query(transaction, AGENTS_SQL.procedureUsage, [
					tenantId,
					skillId,
				])
			)[0] as unknown as {
				assignments: number;
				active_definitions: number | null;
			};
			return {
				assignments: counts.assignments,
				activeDefinitions: counts.active_definitions ?? 0,
			};
		});
	}

	async deleteProcedure(tenantId: string, skillId: string): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			return (
				(await this.#exec(transaction, AGENTS_SQL.deleteProcedure, [
					tenantId,
					skillId,
				])) === 1
			);
		});
	}

	async listRuns(
		tenantId: string,
		limit: number,
	): Promise<readonly AgentRun[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const rows = (await this.#query(transaction, AGENTS_SQL.listRuns, [
				tenantId,
				limit,
			])) as unknown as RunRow[];
			const runs: AgentRun[] = [];
			for (const row of rows) {
				const run = fromRunRow(row);
				runs.push({
					...run,
					procedureSnapshots: await this.#procedureSnapshots(
						transaction,
						tenantId,
						run.id,
					),
				});
			}
			return runs;
		});
	}

	async getRun(
		tenantId: string,
		runId: string,
	): Promise<AgentRunDetail | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.getRun, [tenantId, runId])
			)[0] as unknown as RunRow | undefined;
			if (!row) return null;
			const events = await this.#runEventsIn(transaction, tenantId, runId, 0);
			return {
				...fromRunRow(row),
				procedureSnapshots: await this.#procedureSnapshots(
					transaction,
					tenantId,
					row.id,
				),
				events,
			};
		});
	}

	async #runEventsIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		runId: string,
		afterSequence: number,
	): Promise<readonly AgentExecutionEvent[]> {
		{
			return (
				(await this.#query(transaction, AGENTS_SQL.listRunEvents, [
					tenantId,
					runId,
					afterSequence,
				])) as unknown as RunEventRow[]
			).map(fromRunEventRow);
		}
	}

	async listRunEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
	): Promise<readonly AgentExecutionEvent[]> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#runEventsIn(transaction, tenantId, runId, afterSequence),
		);
	}

	async findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): Promise<AgentRun | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.findRunByIdempotencyKey, [
					tenantId,
					idempotencyKey,
				])
			)[0] as unknown as RunRow | undefined;
			if (!row) return null;
			const run = fromRunRow(row);
			return {
				...run,
				procedureSnapshots: await this.#procedureSnapshots(
					transaction,
					tenantId,
					run.id,
				),
			};
		});
	}

	async enqueueRun(
		execution: AgentRunExecution,
		idempotencyKey: string | null,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRun> {
		return this.#tx(execution.run.tenantId, 'write', async (transaction) => {
			const { run, definition } = execution;
			try {
				await this.#exec(transaction, AGENTS_SQL.enqueueRun1, [
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
				]);
				await this.#exec(transaction, AGENTS_SQL.enqueueRun2, [
					run.id,
					run.tenantId,
					definition.timeoutMs,
				]);
				await this.#exec(transaction, AGENTS_SQL.enqueueRun3, [
					run.id,
					run.tenantId,
					definition.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
				]);
				for (const skill of run.procedureSnapshots) {
					await this.#exec(transaction, AGENTS_SQL.enqueueRun4, [
						run.id,
						run.tenantId,
						skill.id,
						skill.key,
						skill.name,
						skill.revision,
						JSON.stringify(skill.requiredTools),
					]);
				}
				await this.#exec(transaction, AGENTS_SQL.enqueueRun5, [
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
				]);
				await this.#exec(transaction, AGENTS_SQL.enqueueRun6, [
					run.id,
					run.tenantId,
					JSON.stringify(run.requestedActor),
					run.authorizationSubject
						? JSON.stringify(run.authorizationSubject)
						: null,
				]);
				await this.#appendAuditEvent(transaction, audit);
			} catch (error) {
				if (
					String(error).includes('agent_runs_tenant_id_idempotency_key_key')
				) {
					throw new DuplicateRunIdempotencyKeyError();
				}
				throw error;
			}
			return run;
		});
	}

	async listRecoverableRuns(
		now: number,
		limit: number,
	): Promise<readonly RecoverableRun[]> {
		return this.#crossTenant(async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.listRecoverableRuns, [
					now,
					limit,
				])) as unknown as RecoverableRow[]
			).map((row) => ({ tenantId: row.tenant_id, runId: row.id }));
		});
	}

	async claimRun(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRunExecution | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const result = await this.#exec(transaction, AGENTS_SQL.claimRun1, [
					workerId,
					leaseExpiresAt,
					now,
					tenantId,
					runId,
					now,
				]);
				if (result !== 1) {
					return null;
				}
				const row = (
					await this.#query(transaction, AGENTS_SQL.claimRun2, [
						tenantId,
						runId,
					])
				)[0] as unknown as RunRow;
				const execution = executionFromRow(row);
				await this.#appendAuditEvent(transaction, {
					...audit,
					metadata: { ...audit.metadata, attempt: execution.run.attempt },
				});
				return {
					...execution,
					run: {
						...execution.run,
						procedureSnapshots: await this.#procedureSnapshots(
							transaction,
							execution.run.tenantId,
							execution.run.id,
						),
					},
				};
			} catch (error) {
				throw error;
			}
		});
	}

	async renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			return (
				(await this.#exec(transaction, AGENTS_SQL.renewLease, [
					leaseExpiresAt,
					tenantId,
					runId,
					workerId,
				])) === 1
			);
		});
	}

	async consumeRunGrant(input: {
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
	}): Promise<boolean> {
		return this.#tx(input.tenantId, 'write', async (transaction) => {
			await this.#exec(transaction, AGENTS_SQL.consumeRunGrant1, [
				input.consumedAt,
			]);
			const result = await this.#exec(
				transaction,
				AGENTS_SQL.consumeRunGrant2,
				[
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
				],
			);
			return result === 1;
		});
	}

	async appendRunEvent(
		tenantId: string,
		runId: string,
		event: AgentExecutionEvent,
	): Promise<void> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			// A server has multiple connections; MAX(sequence) needs a per-run lock.
			await transaction.query({
				text: 'SELECT id FROM agent_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
				parameters: [tenantId, runId],
			});
			await this.#exec(transaction, AGENTS_SQL.appendRunEvent, [
				runId,
				tenantId,
				event.type,
				event.message,
				stableMetadata(event.metadata ?? {}),
				event.timestamp,
				runId,
				tenantId,
			]);
		});
	}

	/* Settling the run and projecting its cost share one transaction: a run that
	   succeeded but is missing from the rollup would understate every budget
	   check that follows it. */
	async completeRun(
		tenantId: string,
		runId: string,
		workerId: string,
		result: AgentExecutionResult,
		audit: PendingAgentAuditEvent,
	): Promise<void> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const update = await this.#exec(transaction, AGENTS_SQL.completeRun1, [
					result.output,
					JSON.stringify(result.usage),
					result.completedAt,
					tenantId,
					runId,
					workerId,
				]);
				if (update !== 1) throw new Error('Agent run lease was lost.');
				await this.#exec(transaction, AGENTS_SQL.completeRun2, [
					result.structuredOutput === undefined
						? null
						: JSON.stringify(result.structuredOutput),
					tenantId,
					runId,
				]);
				const run = (
					await this.#query(transaction, AGENTS_SQL.completeRun3, [
						tenantId,
						runId,
					])
				)[0] as unknown as {
					agent_id: string;
					agent_name: string;
					model: string;
				};
				await this.#exec(transaction, AGENTS_SQL.completeRun4, [
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
				]);
				await this.#appendAuditEvent(transaction, audit);
			} catch (error) {
				throw error;
			}
		});
	}

	async failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<void> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const update = await this.#exec(transaction, AGENTS_SQL.failRun, [
					code,
					message,
					completedAt,
					tenantId,
					runId,
					workerId,
				]);
				if (update !== 1) throw new Error('Agent run lease was lost.');
				await this.#appendAuditEvent(transaction, audit);
			} catch (error) {
				throw error;
			}
		});
	}

	async cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRun['status'] | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const current = (
					await this.#query(transaction, AGENTS_SQL.cancelRun1, [
						tenantId,
						runId,
					])
				)[0] as unknown as { status: AgentRun['status'] } | undefined;
				if (!current || !['queued', 'running'].includes(current.status)) {
					return null;
				}
				await this.#exec(transaction, AGENTS_SQL.cancelRun2, [
					message,
					completedAt,
					tenantId,
					runId,
				]);
				await this.#appendAuditEvent(transaction, {
					...audit,
					metadata: { ...audit.metadata, previousStatus: current.status },
				});
				return current.status;
			} catch (error) {
				throw error;
			}
		});
	}

	async enqueueAction(
		invocation: AgentActionInvocation,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation> {
		return this.#tx(invocation.tenantId, 'write', async (transaction) => {
			try {
				await this.#exec(transaction, AGENTS_SQL.enqueueAction, [
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
				]);
				await this.#appendAuditEvent(transaction, audit);
			} catch (error) {
				if (
					String(error).includes(
						'agent_action_invocations_tenant_id_idempotency_key_key',
					)
				) {
					throw new DuplicateActionIdempotencyKeyError();
				}
				throw error;
			}
			return invocation;
		});
	}

	async #actionIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		invocationId: string,
	): Promise<AgentActionInvocation | null> {
		const row = (
			await this.#query(transaction, AGENTS_SQL.getAction, [
				tenantId,
				invocationId,
			])
		)[0] as unknown as ActionRow | undefined;
		return row ? fromActionRow(row) : null;
	}

	async getAction(
		tenantId: string,
		invocationId: string,
	): Promise<AgentActionInvocation | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#actionIn(transaction, tenantId, invocationId),
		);
	}

	async findActionByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): Promise<AgentActionInvocation | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query(transaction, AGENTS_SQL.findActionByIdempotencyKey, [
					tenantId,
					idempotencyKey,
				])
			)[0] as unknown as ActionRow | undefined;
			return row ? fromActionRow(row) : null;
		});
	}

	listRecoverableActions(
		now: number,
		limit: number,
	): Promise<
		readonly { readonly tenantId: string; readonly invocationId: string }[]
	> {
		return this.#crossTenant(async (transaction) =>
			(
				(await this.#query(transaction, AGENTS_SQL.listRecoverableActions, [
					now,
					limit,
				])) as unknown as { tenant_id: string; id: string }[]
			).map((row) => ({ tenantId: row.tenant_id, invocationId: row.id })),
		);
	}

	async claimAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const updated = await this.#exec(transaction, AGENTS_SQL.claimAction, [
					workerId,
					leaseExpiresAt,
					now,
					tenantId,
					invocationId,
					now,
				]);
				if (updated !== 1) {
					return null;
				}
				const invocation = (await this.#actionIn(
					transaction,
					tenantId,
					invocationId,
				))!;
				await this.#appendAuditEvent(transaction, {
					...audit,
					metadata: { ...audit.metadata, attempt: invocation.attempt },
				});
				return invocation;
			} catch (error) {
				throw error;
			}
		});
	}

	async renewActionLease(
		tenantId: string,
		invocationId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			return (
				(await this.#exec(transaction, AGENTS_SQL.renewActionLease, [
					leaseExpiresAt,
					tenantId,
					invocationId,
					workerId,
				])) === 1
			);
		});
	}

	async completeAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		output: JsonValue,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const changed =
					(await this.#exec(transaction, AGENTS_SQL.completeAction, [
						JSON.stringify(output),
						completedAt,
						tenantId,
						invocationId,
						workerId,
					])) === 1;
				if (changed) await this.#appendAuditEvent(transaction, audit);
				return changed;
			} catch (error) {
				throw error;
			}
		});
	}

	async failAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		code: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const changed =
					(await this.#exec(transaction, AGENTS_SQL.failAction, [
						code,
						completedAt,
						tenantId,
						invocationId,
						workerId,
					])) === 1;
				if (changed) await this.#appendAuditEvent(transaction, audit);
				return changed;
			} catch (error) {
				throw error;
			}
		});
	}

	async cancelAction(
		tenantId: string,
		invocationId: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation['status'] | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			try {
				const current = await this.#actionIn(
					transaction,
					tenantId,
					invocationId,
				);
				if (!current || !['queued', 'running'].includes(current.status)) {
					return null;
				}
				const changed = await this.#exec(transaction, AGENTS_SQL.cancelAction, [
					completedAt,
					tenantId,
					invocationId,
				]);
				if (changed !== 1) {
					return null;
				}
				await this.#appendAuditEvent(transaction, {
					...audit,
					metadata: { ...audit.metadata, previousStatus: current.status },
				});
				return current.status;
			} catch (error) {
				throw error;
			}
		});
	}

	async #appendAuditEvent(
		transaction: DatabaseTransaction,
		event: PendingAgentAuditEvent,
	): Promise<AgentAuditEvent> {
		await transaction.query({
			text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
			parameters: [`agents.core.audit:${event.tenantId}`],
		});
		const previous = (
			await this.#query(transaction, AGENTS_SQL.appendAuditEvent1, [
				event.tenantId,
			])
		)[0] as unknown as
			| { sequence: number | string; event_hash: string }
			| undefined;
		/* count and every BIGINT arrive as a string from the server driver, so the
		   next sequence must be added as a number. Without this the chain reads
		   1, then "11", then "111". */
		const sequence = integer(previous?.sequence ?? 0) + 1;
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
		await this.#exec(transaction, AGENTS_SQL.appendAuditEvent2, [
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
		]);
		return created;
	}

	async appendAuditEvent(
		event: PendingAgentAuditEvent,
	): Promise<AgentAuditEvent> {
		return this.#tx(event.tenantId, 'write', (transaction) =>
			this.#appendAuditEvent(transaction, event),
		);
	}

	async claimMeterRefusal(
		tenantId: string,
		meter: string,
		period: string,
		at: number,
	): Promise<boolean> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			/* The earlier month goes in the same transaction as the claim, so the
			   workspace holds one row per meter however long it keeps refusing. */
			await this.#exec(transaction, AGENTS_SQL.pruneMeterRefusals, [
				tenantId,
				meter,
				period,
			]);
			const claimed = await this.#query<{ tenant_id: string }>(
				transaction,
				AGENTS_SQL.claimMeterRefusal,
				[tenantId, meter, period, at],
			);
			return claimed.length > 0;
		});
	}

	async listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AgentAuditEvent[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.listAuditEvents, [
					tenantId,
					limit,
				])) as unknown as AuditRow[]
			).map(fromAuditRow);
		});
	}

	async pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): Promise<AgentAuditPage> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const rows = (cursor
				? await this.#query(transaction, AGENTS_SQL.pageAuditEvents1, [
						tenantId,
						cursor.occurredAt,
						cursor.occurredAt,
						cursor.sequence,
						limit + 1,
					])
				: await this.#query(transaction, AGENTS_SQL.pageAuditEvents2, [
						tenantId,
						limit + 1,
					])) as unknown as AuditRow[];
			const page = rows.slice(0, limit).map(fromAuditRow);
			const last = page[page.length - 1];
			return {
				events: page,
				nextCursor:
					rows.length > limit && last
						? `${last.occurredAt}:${last.sequence}`
						: null,
			};
		});
	}

	async verifyAuditChain(tenantId: string): Promise<boolean> {
		return (await this.verifyAuditChainDetailed(tenantId)).verified;
	}

	async verifyAuditChainDetailed(
		tenantId: string,
	): Promise<AuditChainVerification> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const events = (
				(await this.#query(transaction, AGENTS_SQL.verifyAuditChainDetailed, [
					tenantId,
				])) as unknown as AuditRow[]
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
		});
	}

	async usageByDay(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): Promise<readonly AgentUsageDay[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.usageByDay, [
					tenantId,
					fromDay,
					toDay,
				])) as unknown as UsageRow[]
			).map((row) => ({ day: row.day, ...fromUsageRow(row) }));
		});
	}

	async usageByAgent(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): Promise<readonly AgentUsageAgent[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			return (
				(await this.#query(transaction, AGENTS_SQL.usageByAgent, [
					tenantId,
					fromDay,
					toDay,
				])) as unknown as UsageRow[]
			).map((row) => ({
				agentId: row.agent_id,
				agentName: row.agent_name,
				...fromUsageRow(row),
			}));
		});
	}

	async usageTotal(
		tenantId: string,
		fromDay: string,
		agentId: string | null,
	): Promise<AgentUsageBucket> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (agentId === null
				? (
						await this.#query(transaction, AGENTS_SQL.usageTotal1, [
							tenantId,
							fromDay,
						])
					)[0]
				: (
						await this.#query(transaction, AGENTS_SQL.usageTotal2, [
							tenantId,
							agentId,
							fromDay,
						])
					)[0]) as unknown as UsageRow | undefined;
			return row
				? fromUsageRow(row)
				: {
						runs: 0,
						inputTokens: 0,
						outputTokens: 0,
						costMicroUsd: 0,
						unpricedRuns: 0,
					};
		});
	}

	/* The operations behind the declared data classes. Each runs on this
	   module's own lease, inside its own tenant-scoped transaction. */

	async exportRunsPage(
		tenantId: string,
		after: AgentRunExportCursor | null,
		limit: number,
	): Promise<readonly ExportedAgentRun[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const runs = (after === null
				? await this.#query(transaction, AGENTS_SQL.exportRunsPage1, [
						tenantId,
						limit,
					])
				: await this.#query(transaction, AGENTS_SQL.exportRunsPage2, [
						tenantId,
						after.queuedAt,
						after.queuedAt,
						after.id,
						limit,
					])) as unknown as RunRow[];
			if (runs.length === 0) return [];
			/* One query for the steps of the whole page: a run is a row, not a
			   round trip. */
			const events = (await this.#query(
				transaction,
				AGENTS_SQL.exportRunEvents,
				[tenantId, runs.map((run) => run.id)],
			)) as unknown as RunEventPageRow[];
			const steps = new Map<string, AgentExecutionEvent[]>();
			for (const event of events) {
				const existing = steps.get(event.run_id);
				if (existing) existing.push(fromRunEventRow(event));
				else steps.set(event.run_id, [fromRunEventRow(event)]);
			}
			return runs.map((run) => ({
				run: fromRunRow(run),
				events: steps.get(run.id) ?? [],
			}));
		});
	}

	async deleteSettledRunsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#tx(tenantId, 'write', (transaction) =>
			this.#exec(transaction, AGENTS_SQL.deleteSettledRunsBefore, [
				tenantId,
				before,
				limit,
			]),
		);
	}

	/* A run this removes while a worker holds it takes its lease with it: the
	   next renewal finds no row, the worker stops the execution as it does for
	   any lost lease, and its settle write reaches nothing. */
	async deleteRunsRequestedBy(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.#tx(tenantId, 'write', (transaction) =>
			this.#exec(transaction, AGENTS_SQL.deleteRunsRequestedBy, [
				tenantId,
				accountId,
				limit,
			]),
		);
	}

	async exportAuditEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly AgentAuditEvent[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				(await this.#query(transaction, AGENTS_SQL.exportAuditEventsPage, [
					tenantId,
					afterSequence,
					limit,
				])) as unknown as AuditRow[]
			).map(fromAuditRow),
		);
	}

	async close(): Promise<void> {}
}
