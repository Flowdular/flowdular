import { randomUUID } from 'node:crypto';
import { resolveTemplate } from '@flowdular/contracts';
import {
	validateJsonValue,
	type AgentHarness,
	type AgentOutputContract,
	type AgentRunTrigger,
} from '@flowdular/harness';
import {
	actorsEqual,
	normalizeActor,
	type Actor,
	type UserActor,
} from '@flowdular/kernel';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import {
	agentContextValues,
	type AgentRunContext,
} from '../domain/context-variables.ts';
import { groupRunTimeline } from '../domain/run-timeline.ts';
import type {
	AgentAuditPage,
	AgentDefinition,
	AgentDefinitionRevision,
	ModuleAgentBinding,
	ModuleAgentDefinition,
	ModuleAgentView,
	AgentProviderConnection,
	AgentRun,
	AgentRunDetail,
	AgentRunTimeline,
	AgentProcedure,
	AgentProcedureSnapshot,
	AgentWorkerStatus,
	AuditChainVerification,
	CreateAgentProcedureInput,
	CreateAgentInput,
	EnqueueAgentRunInput,
	UpdateAgentProcedureInput,
	UpdateAgentInput,
	UpdateModuleAgentBindingInput,
} from '../domain/types.ts';
import type { AgentSettingsReader } from '../settings.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentProcedureKeyError,
	DuplicateRunIdempotencyKeyError,
	ModuleAgentBindingConflictError,
	type AgentRepository,
} from './repository.ts';
import type { AgentProviderService } from './provider-service.ts';
import type { AgentWorker } from './worker.ts';
import { normalizeModuleAgentDefinitions } from '../server/define-agent.ts';

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 100;
const TERMINAL_STATUSES: readonly AgentRun['status'][] = [
	'succeeded',
	'failed',
	'cancelled',
];

function outputContract(value: AgentOutputContract): AgentOutputContract {
	if (value.kind === 'text') return { kind: 'text' };
	const name = bounded(value.name, 'outputContract.name', 1, 64);
	if (
		!value.schema ||
		Array.isArray(value.schema) ||
		typeof value.schema !== 'object'
	) {
		throw new AgentServiceError(
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema must be a JSON object no larger than 32768 characters.',
		);
	}
	let serialized: string;
	try {
		validateJsonValue(
			value.schema,
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema',
		);
		serialized = JSON.stringify(value.schema);
	} catch {
		throw new AgentServiceError(
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema must be JSON serializable.',
		);
	}
	if (serialized.length > 32_768) {
		throw new AgentServiceError(
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema must be a JSON object no larger than 32768 characters.',
		);
	}
	return { kind: 'json-schema', name, schema: value.schema };
}

/* `occurredAt:sequence` of the last row of the previous page. Both halves are
   non-negative integers; anything else is a client error, never a silent
   first-page fallback. */
function auditCursor(
	raw: string | null,
): { readonly occurredAt: number; readonly sequence: number } | null {
	if (raw === null || raw === '') return null;
	const match = /^(\d+):(\d+)$/.exec(raw);
	const occurredAt = match ? Number(match[1]) : NaN;
	const sequence = match ? Number(match[2]) : NaN;
	if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(sequence)) {
		throw new AgentServiceError('INVALID_CURSOR', 'cursor is malformed.', 400);
	}
	return { occurredAt, sequence };
}

export class AgentServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'AgentServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AgentServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new AgentServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

function requestedActor(value: Actor | string): Actor {
	if (typeof value === 'string') {
		const id = bounded(value, 'actorId', 1, 128);
		return { kind: 'user', id, label: id };
	}
	const actor = normalizeActor(value);
	if (!actor) throw new AgentServiceError('INVALID_ACTOR', 'Actor is invalid.');
	return actor;
}

function agentKey(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized)) {
		throw new AgentServiceError(
			'INVALID_AGENT_KEY',
			'key must contain 3 to 64 lowercase letters, numbers, or hyphens.',
		);
	}
	return normalized;
}

function identifier(value: string, field: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(normalized)) {
		throw new AgentServiceError(
			'INVALID_IDENTIFIER',
			`${field} must be a lowercase dot-separated identifier.`,
		);
	}
	return normalized;
}

function toolList(value: readonly string[]): readonly string[] {
	if (value.length > 32) {
		throw new AgentServiceError(
			'TOOL_LIMIT_EXCEEDED',
			'An agent can allow at most 32 tools.',
		);
	}
	return [...new Set(value.map((tool) => identifier(tool, 'tool')))].sort();
}

function procedureIdList(value: readonly string[]): readonly string[] {
	if (value.length > 8) {
		throw new AgentServiceError(
			'SKILL_LIMIT_EXCEEDED',
			'An agent can attach at most 8 procedures.',
		);
	}
	return [
		...new Set(value.map((id) => bounded(id, 'procedure id', 1, 128))),
	].sort();
}

function procedureStatus(
	value: CreateAgentProcedureInput['status'],
): AgentProcedure['status'] {
	if (!['draft', 'active', 'archived'].includes(value)) {
		throw new AgentServiceError(
			'INVALID_SKILL_STATUS',
			'Agent procedure status is not supported.',
		);
	}
	return value;
}

function executionLimits(
	input: CreateAgentInput,
	defaultMaxOutputTokens: number,
): {
	maxSteps: number;
	timeoutMs: number;
	temperature: number;
	maxOutputTokens: number;
} {
	if (
		!Number.isSafeInteger(input.maxSteps) ||
		input.maxSteps < 1 ||
		input.maxSteps > 32
	) {
		throw new AgentServiceError(
			'INVALID_MAX_STEPS',
			'maxSteps must be between 1 and 32.',
		);
	}
	if (
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs < 250 ||
		input.timeoutMs > 86_400_000
	) {
		throw new AgentServiceError(
			'INVALID_TIMEOUT',
			'timeoutMs must be between 250 and 86400000.',
		);
	}
	if (
		!Number.isFinite(input.temperature) ||
		input.temperature < 0 ||
		input.temperature > 2
	) {
		throw new AgentServiceError(
			'INVALID_TEMPERATURE',
			'temperature must be between 0 and 2.',
		);
	}
	const maxOutputTokens = input.maxOutputTokens ?? defaultMaxOutputTokens;
	if (
		!Number.isSafeInteger(maxOutputTokens) ||
		maxOutputTokens < 256 ||
		maxOutputTokens > 65_536
	) {
		throw new AgentServiceError(
			'INVALID_MAX_OUTPUT_TOKENS',
			'maxOutputTokens must be between 256 and 65536.',
		);
	}
	return {
		maxSteps: input.maxSteps,
		timeoutMs: input.timeoutMs,
		temperature: input.temperature,
		maxOutputTokens,
	};
}

function status(value: CreateAgentInput['status']): CreateAgentInput['status'] {
	if (!['draft', 'active', 'paused', 'archived'].includes(value)) {
		throw new AgentServiceError(
			'INVALID_AGENT_STATUS',
			'Agent status is not supported.',
		);
	}
	return value;
}

function trigger(value: AgentRunTrigger): AgentRunTrigger {
	if (!['playground', 'workflow', 'service', 'schedule'].includes(value)) {
		throw new AgentServiceError(
			'INVALID_TRIGGER',
			'Agent run trigger is not supported.',
		);
	}
	return value;
}

/* Absent means no cap is configured. Returning a refusal instead of throwing
   keeps the budget reader free of any dependency on this module. */
export interface AgentBudgetGuard {
	check(
		tenantId: string,
		agentId: string,
		now: number,
	): Promise<{ readonly code: string; readonly message: string } | null>;
}

export class AgentService {
	readonly #moduleAgents = new Map<string, ModuleAgentDefinition>();

	constructor(
		private readonly repository: AgentRepository,
		private readonly harness: AgentHarness,
		private readonly worker: AgentWorker,
		private readonly providerService?: AgentProviderService,
		private readonly now: () => number = Date.now,
		private readonly settings?: AgentSettingsReader,
		private readonly budget?: AgentBudgetGuard,
	) {}

	workerStatus(): AgentWorkerStatus {
		return this.worker.status();
	}

	async providers(
		tenantId: string,
	): Promise<readonly AgentProviderConnection[]> {
		if (this.providerService) return this.providerService.list(tenantId);
		return this.harness.providers().map((id) => ({
			id,
			tenantId,
			key: id,
			name: id,
			kind: 'local-simulation' as const,
			enabled: true,
			resourceName: null,
			baseURL: null,
			models: [],
			credentialConfigured: false,
			credentialRevision: 0,
			readiness: {
				status: 'healthy' as const,
				model: null,
				latencyMs: 0,
				errorCode: null,
				checkedAt: 0,
			},
			revision: 1,
			createdBy: 'system',
			createdAt: 0,
			updatedBy: 'system',
			updatedAt: 0,
		}));
	}

	tools(): readonly string[] {
		return this.harness.tools();
	}

	async reconcileModuleAgents(
		definitions: readonly ModuleAgentDefinition[],
	): Promise<void> {
		const normalized = normalizeModuleAgentDefinitions(definitions);
		await this.repository.reconcileModuleAgents(normalized, this.now());
		this.#moduleAgents.clear();
		for (const definition of normalized) {
			this.#moduleAgents.set(definition.id, definition);
		}
	}

	async listModuleAgents(
		tenantId: string,
	): Promise<readonly ModuleAgentView[]> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const bindings = new Map(
			(await this.repository.listModuleAgentBindings(trustedTenantId)).map(
				(binding) => [binding.agentId, binding] as const,
			),
		);
		const views: ModuleAgentView[] = [];
		for (const definition of [...this.#moduleAgents.values()].sort(
			(left, right) => left.id.localeCompare(right.id),
		)) {
			views.push(
				await this.#moduleAgentView(
					trustedTenantId,
					definition,
					bindings.get(definition.id) ?? null,
				),
			);
		}
		return views;
	}

	async configureModuleAgent(
		tenantId: string,
		actorId: string,
		input: UpdateModuleAgentBindingInput,
	): Promise<ModuleAgentView> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const id = bounded(input.agentId, 'agentId', 1, 128);
		const definition = this.#moduleAgents.get(id);
		if (!definition) {
			throw new AgentServiceError(
				'MODULE_AGENT_UNAVAILABLE',
				'The module-owned agent is not registered by an enabled module.',
				409,
			);
		}
		if (
			!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 0
		) {
			throw new AgentServiceError(
				'MODULE_AGENT_BINDING_REVISION_INVALID',
				'expectedRevision must be a non-negative integer.',
			);
		}
		if (!['active', 'paused'].includes(input.status)) {
			throw new AgentServiceError(
				'INVALID_AGENT_STATUS',
				'Module agent binding status must be active or paused.',
			);
		}
		const provider = bounded(input.provider, 'provider', 1, 128);
		const model = bounded(input.model, 'model', 1, 160);
		await this.assertProviderConfigured(trustedTenantId, provider, model);
		if (input.status === 'active' && this.providerService) {
			await this.providerService.assertUsable(trustedTenantId, provider, model);
		}
		const enabledTools = toolList(input.enabledTools);
		const outsideMaximum = enabledTools.find(
			(tool) => !definition.allowedTools.includes(tool),
		);
		if (outsideMaximum) {
			throw new AgentServiceError(
				'MODULE_AGENT_TOOL_NOT_ALLOWED',
				`Tool ${outsideMaximum} is outside the module-owned allowlist.`,
				403,
			);
		}
		this.assertToolsRegistered(enabledTools);
		const existing = await this.repository.getModuleAgentBinding(
			trustedTenantId,
			id,
		);
		if ((existing?.revision ?? 0) !== input.expectedRevision) {
			throw new AgentServiceError(
				'MODULE_AGENT_BINDING_REVISION_CONFLICT',
				'The module agent binding changed. Reload before saving.',
				409,
			);
		}
		const configurationChanged =
			!existing ||
			existing.provider !== provider ||
			existing.model !== model ||
			JSON.stringify(existing.enabledTools) !== JSON.stringify(enabledTools) ||
			existing.moduleDefinitionRevision !== definition.definitionRevision;
		if (existing && !configurationChanged && existing.status === input.status) {
			return await this.#moduleAgentView(trustedTenantId, definition, existing);
		}
		const updatedAt = this.now();
		const identity = bounded(actorId, 'actorId', 1, 128);
		const binding: ModuleAgentBinding = {
			tenantId: trustedTenantId,
			agentId: definition.id,
			provider,
			model,
			enabledTools,
			status: input.status,
			moduleDefinitionRevision: definition.definitionRevision,
			executableRevision: existing
				? existing.executableRevision + (configurationChanged ? 1 : 0)
				: 1,
			revision: (existing?.revision ?? 0) + 1,
			updatedBy: identity,
			updatedAt,
		};
		try {
			await this.repository.saveModuleAgentBinding(
				binding,
				definition,
				input.expectedRevision,
				{
					tenantId: trustedTenantId,
					actorId: identity,
					action: existing
						? 'module-agent.binding-updated'
						: 'module-agent.binding-created',
					subjectType: 'agent',
					subjectId: definition.id,
					metadata: {
						moduleId: definition.moduleId,
						definitionRevision: definition.definitionRevision,
						executableRevision: binding.executableRevision,
						bindingRevision: binding.revision,
						status: binding.status,
					},
					occurredAt: updatedAt,
				},
			);
		} catch (error) {
			if (error instanceof ModuleAgentBindingConflictError) {
				throw new AgentServiceError(
					'MODULE_AGENT_BINDING_REVISION_CONFLICT',
					error.message,
					409,
				);
			}
			throw error;
		}
		return await this.#moduleAgentView(trustedTenantId, definition, binding);
	}

	async listAgents(tenantId: string): Promise<readonly AgentDefinition[]> {
		return await this.repository.listAgents(
			bounded(tenantId, 'tenantId', 1, 128),
		);
	}

	async listProcedures(tenantId: string): Promise<readonly AgentProcedure[]> {
		return await this.repository.listProcedures(
			bounded(tenantId, 'tenantId', 1, 128),
		);
	}

	async pageAuditEvents(
		tenantId: string,
		cursor: string | null,
		limit: number,
	): Promise<AgentAuditPage> {
		const size = Number.isSafeInteger(limit)
			? Math.min(Math.max(1, Math.trunc(limit)), MAX_AUDIT_PAGE)
			: DEFAULT_AUDIT_PAGE;
		return await this.repository.pageAuditEvents(
			bounded(tenantId, 'tenantId', 1, 128),
			auditCursor(cursor),
			size,
		);
	}

	async verifyAudit(tenantId: string): Promise<AuditChainVerification> {
		return await this.repository.verifyAuditChainDetailed(
			bounded(tenantId, 'tenantId', 1, 128),
		);
	}

	async createProcedure(
		tenantId: string,
		actorId: string,
		input: CreateAgentProcedureInput,
	): Promise<AgentProcedure> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const requiredTools = toolList(input.requiredTools);
		this.assertToolsRegistered(requiredTools);
		const now = this.now();
		const procedure: AgentProcedure = {
			id: randomUUID(),
			tenantId: trustedTenantId,
			key: agentKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			description: bounded(input.description, 'description', 2, 500),
			instructions: bounded(input.instructions, 'instructions', 8, 8_000),
			requiredTools,
			status: 'draft',
			revision: 1,
			createdBy: actor,
			createdAt: now,
			updatedBy: actor,
			updatedAt: now,
		};
		try {
			const created = await this.repository.createProcedure(procedure);
			await this.repository.appendAuditEvent({
				tenantId: trustedTenantId,
				actorId: actor,
				/* Audit action and subject ids are evidence. 0.8 renames the product
				   term, never the history it would have to rewrite. */
				action: 'agent-skill.created',
				subjectType: 'agent-skill',
				subjectId: created.id,
				metadata: { key: created.key, revision: created.revision },
				occurredAt: now,
			});
			return created;
		} catch (error) {
			if (error instanceof DuplicateAgentProcedureKeyError) {
				throw new AgentServiceError('DUPLICATE_SKILL_KEY', error.message, 409);
			}
			throw error;
		}
	}

	async updateProcedure(
		tenantId: string,
		procedureId: string,
		actorId: string,
		input: UpdateAgentProcedureInput,
	): Promise<AgentProcedure> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = await this.repository.getProcedure(
			trustedTenantId,
			bounded(procedureId, 'procedureId', 1, 128),
		);
		if (!existing) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent procedure not found.',
				404,
			);
		}
		if (input.expectedRevision !== existing.revision) {
			throw new AgentServiceError(
				'SKILL_REVISION_CONFLICT',
				'The procedure was changed by another request. Reload before saving.',
				409,
			);
		}
		if (input.status === 'archived' && existing.status !== 'archived') {
			await this.assertSkillCanArchive(trustedTenantId, existing.id);
		}
		const requiredTools = toolList(input.requiredTools);
		this.assertToolsRegistered(requiredTools);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const now = this.now();
		const updated: AgentProcedure = {
			...existing,
			key: agentKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			description: bounded(input.description, 'description', 2, 500),
			instructions: bounded(input.instructions, 'instructions', 8, 8_000),
			requiredTools,
			status: procedureStatus(input.status),
			revision: existing.revision + 1,
			updatedBy: actor,
			updatedAt: now,
		};
		try {
			const result = await this.repository.updateProcedure(updated);
			await this.repository.appendAuditEvent({
				tenantId: trustedTenantId,
				actorId: actor,
				action:
					input.status === 'archived' && existing.status !== 'archived'
						? 'agent-skill.archived'
						: 'agent-skill.updated',
				subjectType: 'agent-skill',
				subjectId: result.id,
				metadata: { revision: result.revision, status: result.status },
				occurredAt: now,
			});
			return result;
		} catch (error) {
			if (error instanceof DuplicateAgentProcedureKeyError) {
				throw new AgentServiceError('DUPLICATE_SKILL_KEY', error.message, 409);
			}
			throw error;
		}
	}

	async archiveProcedure(
		tenantId: string,
		procedureId: string,
		actorId: string,
		expectedRevision: number,
	): Promise<AgentProcedure> {
		const existing = await this.requireSkill(tenantId, procedureId);
		return await this.updateProcedure(tenantId, existing.id, actorId, {
			key: existing.key,
			name: existing.name,
			description: existing.description,
			instructions: existing.instructions,
			requiredTools: existing.requiredTools,
			status: 'archived',
			expectedRevision,
		});
	}

	async deleteProcedure(
		tenantId: string,
		procedureId: string,
		actorId: string,
		expectedRevision: number,
	): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = await this.requireSkill(trustedTenantId, procedureId);
		if (existing.revision !== expectedRevision) {
			throw new AgentServiceError(
				'SKILL_REVISION_CONFLICT',
				'The procedure was changed by another request. Reload before deleting.',
				409,
			);
		}
		if (existing.status !== 'archived') {
			throw new AgentServiceError(
				'SKILL_NOT_ARCHIVED',
				'Archive the procedure before deleting it.',
				409,
			);
		}
		const usage = await this.repository.procedureUsage(
			trustedTenantId,
			existing.id,
		);
		if (usage.assignments > 0) {
			throw new AgentServiceError(
				'SKILL_IN_USE',
				'Remove this procedure from every agent before deleting it.',
				409,
			);
		}
		if (
			!(await this.repository.deleteProcedure(trustedTenantId, existing.id))
		) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent procedure not found.',
				404,
			);
		}
		await this.repository.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: bounded(actorId, 'actorId', 1, 128),
			action: 'agent-skill.deleted',
			subjectType: 'agent-skill',
			subjectId: existing.id,
			metadata: { key: existing.key, revision: existing.revision },
			occurredAt: this.now(),
		});
	}

	async createAgent(
		tenantId: string,
		actorId: string,
		input: CreateAgentInput,
	): Promise<AgentDefinition> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		// Provider references are stored connection IDs, not tool identifiers.
		const provider = bounded(
			input.provider || (this.settings?.defaultProvider(trustedTenantId) ?? ''),
			'provider',
			1,
			128,
		);
		const model = bounded(
			input.model || (this.settings?.defaultModel(trustedTenantId) ?? ''),
			'model',
			1,
			160,
		);
		await this.assertProviderConfigured(trustedTenantId, provider, model);
		const allowedTools = toolList(input.allowedTools);
		this.assertToolsRegistered(allowedTools);
		const procedureIds = procedureIdList(input.procedureIds);
		await this.resolveSkills(trustedTenantId, procedureIds, false);
		const createdAt = this.now();
		const identity = bounded(actorId, 'actorId', 1, 128);
		const agent: AgentDefinition = {
			id: randomUUID(),
			tenantId: trustedTenantId,
			key: agentKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			description: bounded(input.description, 'description', 2, 500),
			instructions: bounded(input.instructions, 'instructions', 8, 40_000),
			provider,
			model,
			allowedTools,
			procedureIds,
			...executionLimits(
				input,
				this.settings?.defaultMaxOutputTokens(trustedTenantId) ??
					DEFAULT_MAX_OUTPUT_TOKENS,
			),
			status: 'draft',
			revision: 1,
			createdBy: identity,
			createdAt,
			updatedBy: identity,
			updatedAt: createdAt,
		};
		try {
			const created = await this.repository.createAgent(agent);
			await this.repository.appendAuditEvent({
				tenantId: created.tenantId,
				actorId: identity,
				action: 'agent.created',
				subjectType: 'agent',
				subjectId: created.id,
				metadata: { key: created.key, revision: created.revision },
				occurredAt: createdAt,
			});
			return created;
		} catch (error) {
			if (error instanceof DuplicateAgentKeyError) {
				throw new AgentServiceError('DUPLICATE_AGENT_KEY', error.message, 409);
			}
			throw error;
		}
	}

	async updateAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		input: UpdateAgentInput,
	): Promise<AgentDefinition> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const id = bounded(agentId, 'agentId', 1, 128);
		this.#refuseModuleAgentMutation(id);
		const existing = await this.repository.getAgent(trustedTenantId, id);
		if (!existing) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		if (input.expectedRevision !== existing.revision) {
			throw new AgentServiceError(
				'AGENT_REVISION_CONFLICT',
				'The agent was changed by another request. Reload before saving.',
				409,
			);
		}
		const provider = bounded(
			input.provider || existing.provider,
			'provider',
			1,
			128,
		);
		const model = bounded(input.model || existing.model, 'model', 1, 160);
		await this.assertProviderConfigured(trustedTenantId, provider, model);
		if (input.status === 'active' && this.providerService) {
			await this.providerService.assertUsable(trustedTenantId, provider, model);
		}
		const allowedTools = toolList(input.allowedTools);
		this.assertToolsRegistered(allowedTools);
		const procedureIds = procedureIdList(input.procedureIds);
		const skills = await this.resolveSkills(
			trustedTenantId,
			procedureIds,
			input.status === 'active',
		);
		if (input.status === 'active') {
			this.assertSkillToolsAllowed(skills, allowedTools);
		}
		const updatedAt = this.now();
		const identity = bounded(actorId, 'actorId', 1, 128);
		const updated: AgentDefinition = {
			...existing,
			key: agentKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			description: bounded(input.description, 'description', 2, 500),
			instructions: bounded(input.instructions, 'instructions', 8, 40_000),
			provider,
			model,
			allowedTools,
			procedureIds,
			...executionLimits(input, existing.maxOutputTokens),
			status: status(input.status),
			revision: existing.revision + 1,
			updatedBy: identity,
			updatedAt,
		};
		try {
			const result = await this.repository.updateAgent(updated);
			await this.repository.appendAuditEvent({
				tenantId: result.tenantId,
				actorId: identity,
				action:
					input.status === 'archived' && existing.status !== 'archived'
						? 'agent.archived'
						: 'agent.updated',
				subjectType: 'agent',
				subjectId: result.id,
				metadata: { revision: result.revision, status: result.status },
				occurredAt: updatedAt,
			});
			return result;
		} catch (error) {
			if (error instanceof DuplicateAgentKeyError) {
				throw new AgentServiceError('DUPLICATE_AGENT_KEY', error.message, 409);
			}
			throw error;
		}
	}

	async archiveAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		expectedRevision: number,
	): Promise<AgentDefinition> {
		this.#refuseModuleAgentMutation(bounded(agentId, 'agentId', 1, 128));
		const existing = await this.requireAgent(tenantId, agentId);
		return await this.updateAgent(tenantId, existing.id, actorId, {
			key: existing.key,
			name: existing.name,
			description: existing.description,
			instructions: existing.instructions,
			provider: existing.provider,
			model: existing.model,
			allowedTools: existing.allowedTools,
			procedureIds: existing.procedureIds,
			maxSteps: existing.maxSteps,
			timeoutMs: existing.timeoutMs,
			temperature: existing.temperature,
			maxOutputTokens: existing.maxOutputTokens,
			status: 'archived',
			expectedRevision,
		});
	}

	async deleteAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		expectedRevision: number,
	): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		this.#refuseModuleAgentMutation(bounded(agentId, 'agentId', 1, 128));
		const existing = await this.requireAgent(trustedTenantId, agentId);
		if (existing.revision !== expectedRevision) {
			throw new AgentServiceError(
				'AGENT_REVISION_CONFLICT',
				'The agent was changed by another request. Reload before deleting.',
				409,
			);
		}
		if (existing.status !== 'archived') {
			throw new AgentServiceError(
				'AGENT_NOT_ARCHIVED',
				'Archive the agent before deleting it.',
				409,
			);
		}
		const usage = await this.repository.agentUsage(
			trustedTenantId,
			existing.id,
		);
		if (usage.runs > 0) {
			throw new AgentServiceError(
				'AGENT_IN_USE',
				'Delete is unavailable while this agent has run history.',
				409,
			);
		}
		if (usage.assignments > 0) {
			throw new AgentServiceError(
				'AGENT_IN_USE',
				'Remove every attached procedure before deleting this agent.',
				409,
			);
		}
		if (!(await this.repository.deleteAgent(trustedTenantId, existing.id))) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		await this.repository.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: bounded(actorId, 'actorId', 1, 128),
			action: 'agent.deleted',
			subjectType: 'agent',
			subjectId: existing.id,
			metadata: { key: existing.key, revision: existing.revision },
			occurredAt: this.now(),
		});
	}

	async listRuns(tenantId: string, limit = 100): Promise<readonly AgentRun[]> {
		const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
		return await this.repository.listRuns(
			bounded(tenantId, 'tenantId', 1, 128),
			boundedLimit,
		);
	}

	async getRun(tenantId: string, runId: string): Promise<AgentRunDetail> {
		const run = await this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		if (!run) {
			throw new AgentServiceError('RUN_NOT_FOUND', 'Agent run not found.', 404);
		}
		return run;
	}

	async getRevisionReference(
		tenantId: string,
		agentId: string,
		revision: number,
	): Promise<{
		readonly agentId: string;
		readonly revision: number;
		readonly name: string;
		readonly status: Exclude<AgentDefinition['status'], 'draft'>;
		readonly supportsStructuredOutput: boolean;
		readonly allowedTools: readonly string[];
	} | null> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		if (!Number.isSafeInteger(revision) || revision < 1) {
			throw new AgentServiceError(
				'INVALID_AGENT_REVISION',
				'revision must be a positive integer.',
			);
		}
		const id = bounded(agentId, 'agentId', 1, 128);
		const retained = await this.repository.getAgentRevision(
			trustedTenantId,
			id,
			revision,
		);
		if (!retained || retained.status === 'draft') return null;
		if (retained.ownership.kind === 'module') {
			const definition = this.#moduleAgents.get(id);
			const binding = await this.repository.getModuleAgentBinding(
				trustedTenantId,
				id,
			);
			if (
				!definition ||
				!binding ||
				(await this.#moduleAgentRevisionUnavailableReason(
					trustedTenantId,
					retained,
					binding,
				))
			) {
				return null;
			}
			return {
				agentId: retained.agentId,
				revision: retained.revision,
				name: retained.name,
				status: binding.status,
				supportsStructuredOutput:
					(await this.providerService?.supportsStructuredOutput(
						trustedTenantId,
						retained.provider,
						retained.model,
					)) ??
					this.harness.providerSupportsStructuredOutput(retained.provider),
				allowedTools: retained.allowedTools,
			};
		}
		const current = await this.repository.getAgent(trustedTenantId, id);
		if (!current || current.status === 'draft') return null;
		return {
			agentId: retained.agentId,
			revision: retained.revision,
			name: retained.name,
			status: current.status === 'active' ? retained.status : current.status,
			supportsStructuredOutput:
				(await this.providerService?.supportsStructuredOutput(
					trustedTenantId,
					retained.provider,
					retained.model,
				)) ?? this.harness.providerSupportsStructuredOutput(retained.provider),
			allowedTools: retained.allowedTools,
		};
	}

	async listRevisionReferences(tenantId: string): Promise<
		readonly {
			readonly agentId: string;
			readonly revision: number;
			readonly name: string;
			readonly status: Exclude<AgentDefinition['status'], 'draft'>;
			readonly supportsStructuredOutput: boolean;
			readonly allowedTools: readonly string[];
		}[]
	> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const current = new Map(
			(await this.repository.listAgents(trustedTenantId)).map(
				(agent) => [agent.id, agent] as const,
			),
		);
		const moduleBindings = new Map(
			(await this.repository.listModuleAgentBindings(trustedTenantId)).map(
				(binding) => [binding.agentId, binding] as const,
			),
		);
		const references = [];
		for (const retained of await this.repository.listAgentRevisions(
			trustedTenantId,
		)) {
			references.push(
				...(await (async () => {
					if (retained.ownership.kind === 'module') {
						const definition = this.#moduleAgents.get(retained.agentId);
						const binding = moduleBindings.get(retained.agentId);
						if (
							!definition ||
							!binding ||
							(await this.#moduleAgentRevisionUnavailableReason(
								trustedTenantId,
								retained,
								binding,
							))
						) {
							return [];
						}
						return [
							{
								agentId: retained.agentId,
								revision: retained.revision,
								name: retained.name,
								status: binding.status,
								supportsStructuredOutput:
									(await this.providerService?.supportsStructuredOutput(
										trustedTenantId,
										retained.provider,
										retained.model,
									)) ??
									this.harness.providerSupportsStructuredOutput(
										retained.provider,
									),
								allowedTools: retained.allowedTools,
							},
						];
					}
					const agent = current.get(retained.agentId);
					if (
						!agent ||
						agent.status === 'draft' ||
						retained.status === 'draft'
					) {
						return [];
					}
					return [
						{
							agentId: retained.agentId,
							revision: retained.revision,
							name: retained.name,
							status:
								agent.status === 'active' ? retained.status : agent.status,
							supportsStructuredOutput:
								(await this.providerService?.supportsStructuredOutput(
									trustedTenantId,
									retained.provider,
									retained.model,
								)) ??
								this.harness.providerSupportsStructuredOutput(
									retained.provider,
								),
							allowedTools: retained.allowedTools,
						},
					];
				})()),
			);
		}
		return references;
	}

	async enqueueRevisionRun(
		context: {
			readonly tenantId: string;
			readonly workflowRunId: string;
			readonly actor: Actor;
			readonly authorizationSubject?: UserActor;
			readonly permissionSnapshot: readonly string[];
		},
		input: {
			readonly agentId: string;
			readonly revision: number;
			readonly input: string;
			readonly toolGrants: readonly string[];
			readonly outputContract: AgentOutputContract;
			readonly idempotencyKey: string;
		},
	): Promise<{ readonly runId: string; readonly created: boolean }> {
		const trustedTenantId = bounded(context.tenantId, 'tenantId', 1, 128);
		const workflowRunId = bounded(
			context.workflowRunId,
			'workflowRunId',
			1,
			128,
		);
		const actor = normalizeActor(context.actor);
		if (!actor) {
			throw new AgentServiceError(
				'INVALID_ACTOR',
				'The workflow actor is invalid.',
			);
		}
		if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
			throw new AgentServiceError(
				'INVALID_AGENT_REVISION',
				'revision must be a positive integer.',
			);
		}
		const agentId = bounded(input.agentId, 'agentId', 1, 128);
		const contract = outputContract(input.outputContract);
		const idempotencyKey = bounded(
			input.idempotencyKey,
			'idempotencyKey',
			8,
			128,
		);
		const prompt = bounded(input.input, 'input', 1, 100_000);
		const suppliedSubject = context.authorizationSubject
			? normalizeActor(context.authorizationSubject)
			: undefined;
		const derivedSubject =
			actor.kind === 'user'
				? actor
				: actor.kind === 'service'
					? actor.configuredBy
					: undefined;
		const authorizationSubject = suppliedSubject ?? derivedSubject;
		if (
			!authorizationSubject ||
			authorizationSubject.kind !== 'user' ||
			(derivedSubject && authorizationSubject.id !== derivedSubject.id)
		) {
			throw new AgentServiceError(
				'INVALID_AUTHORIZATION_SUBJECT',
				'The workflow authorization subject is invalid.',
			);
		}
		const permissionSnapshot = [...new Set(context.permissionSnapshot)].sort();
		const requestedToolGrants = toolList(input.toolGrants);
		const requestMatches = (candidate: AgentRun): boolean =>
			candidate.agentId === agentId &&
			candidate.agentRevision === input.revision &&
			candidate.input === prompt &&
			candidate.workflowRunId === workflowRunId &&
			actorsEqual(candidate.requestedActor, actor) &&
			candidate.authorizationSubject?.id === authorizationSubject.id &&
			JSON.stringify(candidate.permissionSnapshot) ===
				JSON.stringify(permissionSnapshot) &&
			JSON.stringify(candidate.toolGrants) ===
				JSON.stringify(requestedToolGrants) &&
			JSON.stringify(candidate.outputContract) === JSON.stringify(contract);
		const existing = await this.repository.findRunByIdempotencyKey(
			trustedTenantId,
			idempotencyKey,
		);
		if (existing) {
			if (!requestMatches(existing)) {
				throw new AgentServiceError(
					'AGENT_RUN_IDEMPOTENCY_CONFLICT',
					'The idempotency key is already bound to another agent request.',
					409,
				);
			}
			return { runId: existing.id, created: false };
		}
		const retained = await this.repository.getAgentRevision(
			trustedTenantId,
			agentId,
			input.revision,
		);
		if (!retained) {
			throw new AgentServiceError(
				'AGENT_REVISION_NOT_FOUND',
				'Agent revision not found.',
				404,
			);
		}
		let currentStatus: AgentDefinition['status'];
		if (retained.ownership.kind === 'module') {
			const definition = this.#moduleAgents.get(agentId);
			const binding = await this.repository.getModuleAgentBinding(
				trustedTenantId,
				agentId,
			);
			if (!definition || !binding) {
				throw new AgentServiceError(
					'AGENT_REVISION_NOT_FOUND',
					'Agent revision not found.',
					404,
				);
			}
			const unavailable = await this.#moduleAgentRevisionUnavailableReason(
				trustedTenantId,
				retained,
				binding,
			);
			if (unavailable) {
				throw new AgentServiceError(
					'MODULE_AGENT_UNAVAILABLE',
					unavailable,
					409,
				);
			}
			currentStatus = binding.status;
		} else {
			const current = await this.repository.getAgent(trustedTenantId, agentId);
			if (!current) {
				throw new AgentServiceError(
					'AGENT_REVISION_NOT_FOUND',
					'Agent revision not found.',
					404,
				);
			}
			currentStatus = current.status;
		}
		if (
			(retained.ownership.kind === 'tenant' && retained.status !== 'active') ||
			currentStatus !== 'active'
		) {
			throw new AgentServiceError(
				'AGENT_REVISION_NOT_ACTIVE',
				'Only an active retained agent revision can accept workflow runs.',
				409,
			);
		}
		const supportsStructuredOutput =
			(await this.providerService?.supportsStructuredOutput(
				trustedTenantId,
				retained.provider,
				retained.model,
			)) ?? this.harness.providerSupportsStructuredOutput(retained.provider);
		if (contract.kind === 'json-schema' && !supportsStructuredOutput) {
			throw new AgentServiceError(
				'STRUCTURED_OUTPUT_UNSUPPORTED',
				'The pinned agent model cannot guarantee structured output.',
				409,
			);
		}
		this.assertToolsRegistered(retained.allowedTools);
		const invalidGrant = requestedToolGrants.find(
			(tool) => !retained.allowedTools.includes(tool),
		);
		if (invalidGrant) {
			throw new AgentServiceError(
				'TOOL_NOT_ALLOWED',
				`Tool ${invalidGrant} is not allowed by the pinned agent revision.`,
				403,
			);
		}
		const effectiveToolGrants = this.harness.effectiveToolGrants(
			retained.allowedTools,
			requestedToolGrants,
			permissionSnapshot,
		);
		const missingProcedureGrant = retained.procedures
			.flatMap((procedure) => procedure.requiredTools)
			.find((tool) => !effectiveToolGrants.includes(tool));
		if (missingProcedureGrant) {
			/* The code is a stable API identifier and keeps its procedure-era spelling
			   for the same reason the permission ids do. */
			throw new AgentServiceError(
				'SKILL_TOOL_GRANT_REQUIRED',
				`Procedure requires permission for tool ${missingProcedureGrant}.`,
				403,
			);
		}
		const refusal = await this.budget?.check(
			trustedTenantId,
			retained.agentId,
			this.now(),
		);
		if (refusal) {
			throw new AgentServiceError(refusal.code, refusal.message, 409);
		}
		await this.providerService?.ensureUsable(
			trustedTenantId,
			retained.provider,
			retained.model,
			actor.id,
		);
		const resolvedInstructions = resolveTemplate(
			retained.instructions,
			agentContextValues({
				tenantName: trustedTenantId,
				userDisplayName: actor.label,
				userEmail: actor.id,
				now: this.now(),
			}),
		);
		const instructions = [
			resolvedInstructions,
			/* Model-facing wording is deliberately unchanged: the rename is a product
			   and API contract change, not a change to what an agent reads. */
			...retained.procedures.map(
				(procedure) =>
					`\n[Approved procedure: ${procedure.key} revision ${procedure.revision}]\n${procedure.instructions}`,
			),
		].join('\n');
		if (instructions.length > 40_000) {
			throw new AgentServiceError(
				'AGENT_INSTRUCTIONS_TOO_LARGE',
				'Agent and procedure instructions exceed the 40000 character execution limit.',
				409,
			);
		}
		const queuedAt = this.now();
		const run: AgentRun = {
			id: randomUUID(),
			tenantId: trustedTenantId,
			agentId: retained.agentId,
			agentName: retained.name,
			agentRevision: retained.revision,
			trigger: 'workflow',
			status: 'queued',
			input: prompt,
			output: null,
			structuredOutput: null,
			outputContract: contract,
			workflowRunId,
			provider: retained.provider,
			model: retained.model,
			requestedBy: actor.id,
			requestedActor: actor,
			authorizationSubject,
			permissionSnapshot,
			toolGrants: requestedToolGrants,
			procedureSnapshots: retained.procedures.map((procedure) => ({
				id: procedure.id,
				key: procedure.key,
				name: procedure.name,
				revision: procedure.revision,
				requiredTools: procedure.requiredTools,
			})),
			usage: null,
			failureCode: null,
			failureMessage: null,
			attempt: 0,
			queuedAt,
			startedAt: null,
			completedAt: null,
			leaseExpiresAt: null,
		};
		try {
			await this.repository.enqueueRun(
				{
					run,
					definition: {
						id: retained.agentId,
						name: retained.name,
						revision: retained.revision,
						instructions,
						provider: retained.provider,
						model: retained.model,
						allowedTools: retained.allowedTools,
						maxSteps: retained.maxSteps,
						timeoutMs: retained.timeoutMs,
						temperature: retained.temperature,
						maxOutputTokens: retained.maxOutputTokens,
					},
				},
				idempotencyKey,
				{
					tenantId: trustedTenantId,
					actorId: actor.id,
					action: 'agent-run.queued',
					subjectType: 'agent-run',
					subjectId: run.id,
					metadata: {
						agentId: run.agentId,
						agentRevision: run.agentRevision,
						trigger: 'workflow',
						workflowRunId,
					},
					occurredAt: queuedAt,
				},
			);
		} catch (error) {
			if (error instanceof DuplicateRunIdempotencyKeyError) {
				const raced = await this.repository.findRunByIdempotencyKey(
					trustedTenantId,
					idempotencyKey,
				);
				if (raced && requestMatches(raced)) {
					return { runId: raced.id, created: false };
				}
				throw new AgentServiceError(
					'AGENT_RUN_IDEMPOTENCY_CONFLICT',
					'The idempotency key is already bound to another agent request.',
					409,
				);
			}
			throw error;
		}
		this.worker.kick();
		return { runId: run.id, created: true };
	}

	async getWorkflowRun(
		tenantId: string,
		workflowRunId: string,
		runId: string,
	): Promise<AgentRunDetail | null> {
		const run = await this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		return run?.workflowRunId ===
			bounded(workflowRunId, 'workflowRunId', 1, 128)
			? run
			: null;
	}

	async readWorkflowRunEvents(
		tenantId: string,
		workflowRunId: string,
		runId: string,
		afterSequence: number,
	) {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new AgentServiceError(
				'INVALID_EVENT_SEQUENCE',
				'afterSequence must be a non-negative integer.',
			);
		}
		const run = await this.getWorkflowRun(tenantId, workflowRunId, runId);
		return run
			? await this.repository.listRunEvents(run.tenantId, run.id, afterSequence)
			: [];
	}

	async cancelWorkflowRun(
		context: {
			readonly tenantId: string;
			readonly workflowRunId: string;
			readonly actor: Actor;
			readonly permissionSnapshot: readonly string[];
		},
		runId: string,
	): Promise<boolean> {
		const actor = normalizeActor(context.actor);
		if (!actor) {
			throw new AgentServiceError('INVALID_ACTOR', 'Actor is invalid.');
		}
		const run = await this.getWorkflowRun(
			context.tenantId,
			context.workflowRunId,
			runId,
		);
		if (!run) return false;
		if (TERMINAL_STATUSES.includes(run.status)) return false;
		await this.cancelRun(
			context.tenantId,
			actor,
			context.permissionSnapshot,
			run.id,
		);
		return true;
	}

	/* The served shape of one run: stored events folded into timeline entries.
	   Every reader goes through here, so the run screen and any other consumer
	   see the same grouping and the same ceiling. */
	async getRunTimeline(
		tenantId: string,
		runId: string,
	): Promise<AgentRunTimeline> {
		const { events, ...run } = await this.getRun(tenantId, runId);
		return { ...run, timeline: groupRunTimeline(events) };
	}

	async enqueueRun(
		tenantId: string,
		actorInput: Actor | string,
		permissionSnapshot: readonly string[],
		input: EnqueueAgentRunInput,
		context?: AgentRunContext,
	): Promise<AgentRun> {
		return (
			await this.enqueueRunWithOutcome(
				tenantId,
				actorInput,
				permissionSnapshot,
				input,
				context,
			)
		).run;
	}

	async enqueueRunWithOutcome(
		tenantId: string,
		actorInput: Actor | string,
		permissionSnapshot: readonly string[],
		input: EnqueueAgentRunInput,
		context?: AgentRunContext,
	): Promise<{ readonly run: AgentRun; readonly created: boolean }> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = requestedActor(actorInput);
		const identity = actor.id;
		const agentId = bounded(input.agentId, 'agentId', 1, 128);
		const runTrigger = trigger(input.trigger);
		const prompt = bounded(input.input, 'input', 1, 100_000);
		const permissions = [...new Set(permissionSnapshot)].sort();
		const requestedToolGrants = toolList(input.toolGrants);
		const idempotencyKey = input.idempotencyKey
			? bounded(input.idempotencyKey, 'idempotencyKey', 8, 128)
			: null;
		const requestMatches = (candidate: AgentRun): boolean =>
			candidate.agentId === agentId &&
			candidate.trigger === runTrigger &&
			candidate.input === prompt &&
			candidate.workflowRunId === null &&
			actorsEqual(candidate.requestedActor, actor) &&
			JSON.stringify(candidate.permissionSnapshot) ===
				JSON.stringify(permissions) &&
			JSON.stringify(candidate.toolGrants) ===
				JSON.stringify(requestedToolGrants) &&
			candidate.outputContract.kind === 'text';
		if (idempotencyKey) {
			const existing = await this.repository.findRunByIdempotencyKey(
				trustedTenantId,
				idempotencyKey,
			);
			if (existing) {
				if (!requestMatches(existing)) {
					throw new AgentServiceError(
						'AGENT_RUN_IDEMPOTENCY_CONFLICT',
						'The idempotency key is already bound to another agent request.',
						409,
					);
				}
				return { run: existing, created: false };
			}
		}
		const agent = await this.#currentExecutionAgent(trustedTenantId, agentId);
		if (!agent) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		if (agent.status !== 'active') {
			throw new AgentServiceError(
				'AGENT_NOT_ACTIVE',
				'Only an active agent can accept runs.',
				409,
			);
		}
		this.assertToolsRegistered(agent.allowedTools);
		const skills = await this.resolveSkills(
			trustedTenantId,
			agent.procedureIds,
			true,
		);
		this.assertSkillToolsAllowed(skills, agent.allowedTools);
		const invalidGrant = requestedToolGrants.find(
			(tool) => !agent.allowedTools.includes(tool),
		);
		if (invalidGrant) {
			throw new AgentServiceError(
				'TOOL_NOT_ALLOWED',
				`Tool ${invalidGrant} is not allowed by the agent definition.`,
				403,
			);
		}
		const effectiveToolGrants = this.harness.effectiveToolGrants(
			agent.allowedTools,
			requestedToolGrants,
			permissions,
		);
		const missingSkillGrant = skills
			.flatMap((procedure) => procedure.requiredTools)
			.find((tool) => !effectiveToolGrants.includes(tool));
		if (missingSkillGrant) {
			throw new AgentServiceError(
				'SKILL_TOOL_GRANT_REQUIRED',
				`Skill requires explicit run grant for tool ${missingSkillGrant}.`,
				403,
			);
		}
		const refusal = await this.budget?.check(
			trustedTenantId,
			agent.id,
			this.now(),
		);
		if (refusal) {
			throw new AgentServiceError(refusal.code, refusal.message, 409);
		}
		await this.providerService?.ensureUsable(
			trustedTenantId,
			agent.provider,
			agent.model,
			identity,
		);
		const procedureSnapshots: readonly AgentProcedureSnapshot[] = skills.map(
			(procedure) => ({
				id: procedure.id,
				key: procedure.key,
				name: procedure.name,
				revision: procedure.revision,
				requiredTools: procedure.requiredTools,
			}),
		);
		/* The stored definition keeps the raw {{ }} template; the run snapshot
		   carries the text resolved against the run context. Unknown tokens are
		   kept verbatim so a later cross-module resolver can fill them. */
		const resolvedInstructions = resolveTemplate(
			agent.instructions,
			agentContextValues({
				tenantName: context?.tenantName ?? trustedTenantId,
				userDisplayName: context?.userDisplayName ?? identity,
				userEmail: context?.userEmail ?? identity,
				now: this.now(),
			}),
		);
		const instructions = [
			resolvedInstructions,
			...skills.map(
				(procedure) =>
					`\n[Approved procedure: ${procedure.key} revision ${procedure.revision}]\n${procedure.instructions}`,
			),
		].join('\n');
		if (instructions.length > 40_000) {
			throw new AgentServiceError(
				'AGENT_INSTRUCTIONS_TOO_LARGE',
				'Agent and procedure instructions exceed the 40000 character execution limit.',
				409,
			);
		}
		const queuedAt = this.now();
		const run: AgentRun = {
			id: randomUUID(),
			tenantId: trustedTenantId,
			agentId: agent.id,
			agentName: agent.name,
			agentRevision: agent.revision,
			trigger: runTrigger,
			status: 'queued',
			input: prompt,
			output: null,
			structuredOutput: null,
			outputContract: { kind: 'text' },
			workflowRunId: null,
			provider: agent.provider,
			model: agent.model,
			requestedBy: identity,
			requestedActor: actor,
			authorizationSubject:
				actor.kind === 'user'
					? actor
					: actor.kind === 'service'
						? actor.configuredBy
						: null,
			permissionSnapshot: permissions,
			toolGrants: requestedToolGrants,
			procedureSnapshots,
			usage: null,
			failureCode: null,
			failureMessage: null,
			attempt: 0,
			queuedAt,
			startedAt: null,
			completedAt: null,
			leaseExpiresAt: null,
		};
		let queued: AgentRun;
		try {
			queued = await this.repository.enqueueRun(
				{
					run,
					definition: {
						id: agent.id,
						name: agent.name,
						revision: agent.revision,
						instructions,
						provider: agent.provider,
						model: agent.model,
						allowedTools: agent.allowedTools,
						maxSteps: agent.maxSteps,
						timeoutMs: agent.timeoutMs,
						temperature: agent.temperature,
						maxOutputTokens: agent.maxOutputTokens,
					},
				},
				idempotencyKey,
				{
					tenantId: run.tenantId,
					actorId: actor.id,
					action: 'agent-run.queued',
					subjectType: 'agent-run',
					subjectId: run.id,
					metadata: {
						agentId: run.agentId,
						agentRevision: run.agentRevision,
						trigger: run.trigger,
					},
					occurredAt: queuedAt,
				},
			);
		} catch (error) {
			/* Two callers raced past the lookup with the same key; the row that
			   won is the run they both asked for. */
			if (error instanceof DuplicateRunIdempotencyKeyError && idempotencyKey) {
				const existing = await this.repository.findRunByIdempotencyKey(
					trustedTenantId,
					idempotencyKey,
				);
				if (existing && requestMatches(existing)) {
					return { run: existing, created: false };
				}
				throw new AgentServiceError(
					'AGENT_RUN_IDEMPOTENCY_CONFLICT',
					'The idempotency key is already bound to another agent request.',
					409,
				);
			}
			throw error;
		}
		this.worker.kick();
		return { run: queued, created: true };
	}

	/* The requester may cancel their own run; a definitions manager may cancel
	   any run in the tenant. */
	async cancelRun(
		tenantId: string,
		actorInput: Actor | string,
		permissionSnapshot: readonly string[],
		runId: string,
	): Promise<AgentRunTimeline> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = requestedActor(actorInput);
		const identity = actor.id;
		const id = bounded(runId, 'runId', 1, 128);
		const run = await this.getRun(trustedTenantId, id);
		if (
			!actorsEqual(run.requestedActor, actor) &&
			!permissionSnapshot.includes(AGENT_PERMISSIONS.definitionsManage)
		) {
			throw new AgentServiceError(
				'RUN_CANCEL_FORBIDDEN',
				'Only the requester or an agent manager can cancel this run.',
				403,
			);
		}
		if (TERMINAL_STATUSES.includes(run.status)) {
			throw new AgentServiceError(
				'RUN_ALREADY_FINISHED',
				`The run already finished with status ${run.status}.`,
				409,
			);
		}
		const cancelledAt = this.now();
		const previousStatus = await this.repository.cancelRun(
			trustedTenantId,
			id,
			`Cancelled by ${identity}.`,
			cancelledAt,
			{
				tenantId: trustedTenantId,
				actorId: identity,
				action: 'agent-run.cancelled',
				subjectType: 'agent-run',
				subjectId: id,
				metadata: {},
				occurredAt: cancelledAt,
			},
		);
		if (previousStatus === null) {
			throw new AgentServiceError(
				'RUN_ALREADY_FINISHED',
				'The run finished before it could be cancelled.',
				409,
			);
		}
		this.worker.cancel(id);
		return await this.getRunTimeline(trustedTenantId, id);
	}

	private async assertProviderConfigured(
		tenantId: string,
		providerId: string,
		modelId: string,
	): Promise<void> {
		if (!this.providerService) {
			if (!this.harness.providers().includes(providerId)) {
				throw new AgentServiceError(
					'PROVIDER_NOT_AVAILABLE',
					'Provider is not registered in the harness.',
					409,
				);
			}
			return;
		}
		const provider = await this.providerService.get(tenantId, providerId);
		if (!provider) {
			throw new AgentServiceError(
				'PROVIDER_NOT_AVAILABLE',
				'Provider connection is not available in the active tenant.',
				409,
			);
		}
		if (
			!provider.models.some((model) => model.enabled && model.id === modelId)
		) {
			throw new AgentServiceError(
				'MODEL_NOT_CONFIGURED',
				'Model is not enabled for the selected provider.',
				409,
			);
		}
	}

	#refuseModuleAgentMutation(agentId: string): void {
		if (agentId.startsWith('module-agent:')) {
			throw new AgentServiceError(
				'MODULE_AGENT_READ_ONLY',
				'Module-owned behavior is read-only. Update its tenant binding instead.',
				409,
			);
		}
	}

	async #moduleAgentUnavailableReason(
		tenantId: string,
		definition: ModuleAgentDefinition,
		binding: ModuleAgentBinding,
	): Promise<string | null> {
		const missingTool = binding.enabledTools.find(
			(tool) =>
				!definition.allowedTools.includes(tool) ||
				!this.harness.tools().includes(tool),
		);
		if (missingTool) return `Tool ${missingTool} is not available.`;
		try {
			await this.assertProviderConfigured(
				tenantId,
				binding.provider,
				binding.model,
			);
			if (binding.status === 'active' && this.providerService) {
				await this.providerService.assertUsable(
					tenantId,
					binding.provider,
					binding.model,
				);
			}
			return null;
		} catch (error) {
			return error instanceof Error
				? error.message
				: 'The provider binding is unavailable.';
		}
	}

	/* Exact workflow revisions use their retained provider, model and tools.
	   The mutable binding contributes availability only. Checking its current
	   execution configuration here would silently move an old workflow to a
	   newer binding and break the exact-revision contract. */
	async #moduleAgentRevisionUnavailableReason(
		tenantId: string,
		revision: AgentDefinitionRevision,
		binding: ModuleAgentBinding,
	): Promise<string | null> {
		const missingTool = revision.allowedTools.find(
			(tool) => !this.harness.tools().includes(tool),
		);
		if (missingTool) return `Tool ${missingTool} is not available.`;
		try {
			await this.assertProviderConfigured(
				tenantId,
				revision.provider,
				revision.model,
			);
			if (binding.status === 'active' && this.providerService) {
				await this.providerService.assertUsable(
					tenantId,
					revision.provider,
					revision.model,
				);
			}
			return null;
		} catch (error) {
			return error instanceof Error
				? error.message
				: 'The retained module agent revision is unavailable.';
		}
	}

	async #moduleAgentView(
		tenantId: string,
		definition: ModuleAgentDefinition,
		binding: ModuleAgentBinding | null,
	): Promise<ModuleAgentView> {
		if (!binding) {
			return {
				id: definition.id,
				tenantId,
				key: definition.key,
				name: definition.name,
				description: definition.description,
				instructions: definition.instructions,
				provider: null,
				model: null,
				allowedTools: definition.allowedTools,
				enabledTools: [],
				limits: definition.limits,
				status: 'unconfigured',
				revision: null,
				bindingRevision: null,
				unavailableReason: null,
				ownership: definition.ownership,
			};
		}
		const unavailableReason = await this.#moduleAgentUnavailableReason(
			tenantId,
			definition,
			binding,
		);
		return {
			id: definition.id,
			tenantId,
			key: definition.key,
			name: definition.name,
			description: definition.description,
			instructions: definition.instructions,
			provider: binding.provider,
			model: binding.model,
			allowedTools: definition.allowedTools,
			enabledTools: binding.enabledTools,
			limits: definition.limits,
			status: unavailableReason ? 'unavailable' : binding.status,
			revision: binding.executableRevision,
			bindingRevision: binding.revision,
			unavailableReason,
			ownership: definition.ownership,
		};
	}

	async #currentExecutionAgent(
		tenantId: string,
		agentId: string,
	): Promise<AgentDefinition | null> {
		const tenantAgent = await this.repository.getAgent(tenantId, agentId);
		if (tenantAgent) return tenantAgent;
		const definition = this.#moduleAgents.get(agentId);
		if (!definition) return null;
		const binding = await this.repository.getModuleAgentBinding(
			tenantId,
			agentId,
		);
		if (!binding) {
			throw new AgentServiceError(
				'MODULE_AGENT_UNCONFIGURED',
				'Configure a provider and model before running this module agent.',
				409,
			);
		}
		const unavailable = await this.#moduleAgentUnavailableReason(
			tenantId,
			definition,
			binding,
		);
		if (unavailable) {
			throw new AgentServiceError('MODULE_AGENT_UNAVAILABLE', unavailable, 409);
		}
		return {
			id: definition.id,
			tenantId,
			key: definition.key,
			name: definition.name,
			description: definition.description,
			instructions: definition.instructions,
			provider: binding.provider,
			model: binding.model,
			allowedTools: binding.enabledTools,
			procedureIds: [],
			maxSteps: definition.limits.maxSteps,
			timeoutMs: definition.limits.timeoutMs,
			temperature: definition.limits.temperature,
			maxOutputTokens: definition.limits.maxOutputTokens,
			status: binding.status,
			revision: binding.executableRevision,
			createdBy: `module:${definition.moduleId}`,
			createdAt: binding.updatedAt,
			updatedBy: binding.updatedBy,
			updatedAt: binding.updatedAt,
		};
	}

	private async requireAgent(
		tenantId: string,
		agentId: string,
	): Promise<AgentDefinition> {
		const agent = await this.repository.getAgent(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(agentId, 'agentId', 1, 128),
		);
		if (!agent) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		return agent;
	}

	private async requireSkill(
		tenantId: string,
		procedureId: string,
	): Promise<AgentProcedure> {
		const procedure = await this.repository.getProcedure(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(procedureId, 'procedureId', 1, 128),
		);
		if (!procedure) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent procedure not found.',
				404,
			);
		}
		return procedure;
	}

	private async assertSkillCanArchive(
		tenantId: string,
		procedureId: string,
	): Promise<void> {
		const usage = await this.repository.procedureUsage(tenantId, procedureId);
		if (usage.activeDefinitions > 0) {
			throw new AgentServiceError(
				'SKILL_IN_USE',
				'Remove this procedure from every active agent before archiving it.',
				409,
			);
		}
	}

	private assertToolsRegistered(tools: readonly string[]): void {
		const unavailable = tools.find(
			(tool) => !this.harness.tools().includes(tool),
		);
		if (unavailable) {
			throw new AgentServiceError(
				'TOOL_NOT_AVAILABLE',
				`Tool ${unavailable} is not registered.`,
			);
		}
	}

	private async resolveSkills(
		tenantId: string,
		procedureIds: readonly string[],
		requireActive: boolean,
	): Promise<readonly AgentProcedure[]> {
		const procedures: AgentProcedure[] = [];
		for (const procedureId of procedureIds) {
			const procedure = await this.repository.getProcedure(
				tenantId,
				procedureId,
			);
			if (!procedure) {
				throw new AgentServiceError(
					'SKILL_NOT_FOUND',
					'Attached agent procedure was not found in the active tenant.',
					409,
				);
			}
			if (requireActive && procedure.status !== 'active') {
				throw new AgentServiceError(
					'SKILL_NOT_ACTIVE',
					`Skill ${procedure.key} must be active before the agent can run.`,
					409,
				);
			}
			procedures.push(procedure);
		}
		return procedures;
	}

	private assertSkillToolsAllowed(
		skills: readonly AgentProcedure[],
		allowedTools: readonly string[],
	): void {
		const unavailable = skills
			.flatMap((procedure) => procedure.requiredTools)
			.find((tool) => !allowedTools.includes(tool));
		if (unavailable) {
			throw new AgentServiceError(
				'SKILL_TOOL_NOT_ALLOWED',
				`Attached procedure requires ${unavailable}, which the agent does not allow.`,
				409,
			);
		}
	}
}
