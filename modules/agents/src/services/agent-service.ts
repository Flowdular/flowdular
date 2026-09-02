import { randomUUID } from 'node:crypto';
import { resolveTemplate } from '@coreloom/contracts';
import {
	validateJsonValue,
	type AgentHarness,
	type AgentOutputContract,
	type AgentRunTrigger,
} from '@coreloom/harness';
import {
	actorsEqual,
	normalizeActor,
	type Actor,
	type UserActor,
} from '@coreloom/kernel';
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
	AgentSkill,
	AgentSkillSnapshot,
	AgentWorkerStatus,
	AuditChainVerification,
	CreateAgentSkillInput,
	CreateAgentInput,
	EnqueueAgentRunInput,
	UpdateAgentSkillInput,
	UpdateAgentInput,
	UpdateModuleAgentBindingInput,
} from '../domain/types.ts';
import type { AgentSettingsReader } from '../settings.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentSkillKeyError,
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

function skillIdList(value: readonly string[]): readonly string[] {
	if (value.length > 8) {
		throw new AgentServiceError(
			'SKILL_LIMIT_EXCEEDED',
			'An agent can attach at most 8 skills.',
		);
	}
	return [
		...new Set(value.map((id) => bounded(id, 'skill id', 1, 128))),
	].sort();
}

function skillStatus(
	value: CreateAgentSkillInput['status'],
): AgentSkill['status'] {
	if (!['draft', 'active', 'archived'].includes(value)) {
		throw new AgentServiceError(
			'INVALID_SKILL_STATUS',
			'Agent skill status is not supported.',
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
	): { readonly code: string; readonly message: string } | null;
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

	providers(tenantId: string): readonly AgentProviderConnection[] {
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

	reconcileModuleAgents(definitions: readonly ModuleAgentDefinition[]): void {
		const normalized = normalizeModuleAgentDefinitions(definitions);
		this.repository.reconcileModuleAgents(normalized, this.now());
		this.#moduleAgents.clear();
		for (const definition of normalized) {
			this.#moduleAgents.set(definition.id, definition);
		}
	}

	listModuleAgents(tenantId: string): readonly ModuleAgentView[] {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const bindings = new Map(
			this.repository
				.listModuleAgentBindings(trustedTenantId)
				.map((binding) => [binding.agentId, binding] as const),
		);
		return [...this.#moduleAgents.values()]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((definition) =>
				this.#moduleAgentView(
					trustedTenantId,
					definition,
					bindings.get(definition.id) ?? null,
				),
			);
	}

	configureModuleAgent(
		tenantId: string,
		actorId: string,
		input: UpdateModuleAgentBindingInput,
	): ModuleAgentView {
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
		const provider = identifier(input.provider, 'provider');
		const model = bounded(input.model, 'model', 1, 160);
		this.assertProviderConfigured(trustedTenantId, provider, model);
		if (input.status === 'active' && this.providerService) {
			this.providerService.assertUsable(trustedTenantId, provider, model);
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
		const existing = this.repository.getModuleAgentBinding(trustedTenantId, id);
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
			return this.#moduleAgentView(trustedTenantId, definition, existing);
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
			this.repository.saveModuleAgentBinding(
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
		return this.#moduleAgentView(trustedTenantId, definition, binding);
	}

	listAgents(tenantId: string): readonly AgentDefinition[] {
		return this.repository.listAgents(bounded(tenantId, 'tenantId', 1, 128));
	}

	listSkills(tenantId: string): readonly AgentSkill[] {
		return this.repository.listSkills(bounded(tenantId, 'tenantId', 1, 128));
	}

	pageAuditEvents(
		tenantId: string,
		cursor: string | null,
		limit: number,
	): AgentAuditPage {
		const size = Number.isSafeInteger(limit)
			? Math.min(Math.max(1, Math.trunc(limit)), MAX_AUDIT_PAGE)
			: DEFAULT_AUDIT_PAGE;
		return this.repository.pageAuditEvents(
			bounded(tenantId, 'tenantId', 1, 128),
			auditCursor(cursor),
			size,
		);
	}

	verifyAudit(tenantId: string): AuditChainVerification {
		return this.repository.verifyAuditChainDetailed(
			bounded(tenantId, 'tenantId', 1, 128),
		);
	}

	createSkill(
		tenantId: string,
		actorId: string,
		input: CreateAgentSkillInput,
	): AgentSkill {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const requiredTools = toolList(input.requiredTools);
		this.assertToolsRegistered(requiredTools);
		const now = this.now();
		const skill: AgentSkill = {
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
			const created = this.repository.createSkill(skill);
			this.repository.appendAuditEvent({
				tenantId: trustedTenantId,
				actorId: actor,
				action: 'agent-skill.created',
				subjectType: 'agent-skill',
				subjectId: created.id,
				metadata: { key: created.key, revision: created.revision },
				occurredAt: now,
			});
			return created;
		} catch (error) {
			if (error instanceof DuplicateAgentSkillKeyError) {
				throw new AgentServiceError('DUPLICATE_SKILL_KEY', error.message, 409);
			}
			throw error;
		}
	}

	updateSkill(
		tenantId: string,
		skillId: string,
		actorId: string,
		input: UpdateAgentSkillInput,
	): AgentSkill {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = this.repository.getSkill(
			trustedTenantId,
			bounded(skillId, 'skillId', 1, 128),
		);
		if (!existing) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent skill not found.',
				404,
			);
		}
		if (input.expectedRevision !== existing.revision) {
			throw new AgentServiceError(
				'SKILL_REVISION_CONFLICT',
				'The skill was changed by another request. Reload before saving.',
				409,
			);
		}
		if (input.status === 'archived' && existing.status !== 'archived') {
			this.assertSkillCanArchive(trustedTenantId, existing.id);
		}
		const requiredTools = toolList(input.requiredTools);
		this.assertToolsRegistered(requiredTools);
		const actor = bounded(actorId, 'actorId', 1, 128);
		const now = this.now();
		const updated: AgentSkill = {
			...existing,
			key: agentKey(input.key),
			name: bounded(input.name, 'name', 2, 120),
			description: bounded(input.description, 'description', 2, 500),
			instructions: bounded(input.instructions, 'instructions', 8, 8_000),
			requiredTools,
			status: skillStatus(input.status),
			revision: existing.revision + 1,
			updatedBy: actor,
			updatedAt: now,
		};
		try {
			const result = this.repository.updateSkill(updated);
			this.repository.appendAuditEvent({
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
			if (error instanceof DuplicateAgentSkillKeyError) {
				throw new AgentServiceError('DUPLICATE_SKILL_KEY', error.message, 409);
			}
			throw error;
		}
	}

	archiveSkill(
		tenantId: string,
		skillId: string,
		actorId: string,
		expectedRevision: number,
	): AgentSkill {
		const existing = this.requireSkill(tenantId, skillId);
		return this.updateSkill(tenantId, existing.id, actorId, {
			key: existing.key,
			name: existing.name,
			description: existing.description,
			instructions: existing.instructions,
			requiredTools: existing.requiredTools,
			status: 'archived',
			expectedRevision,
		});
	}

	deleteSkill(
		tenantId: string,
		skillId: string,
		actorId: string,
		expectedRevision: number,
	): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = this.requireSkill(trustedTenantId, skillId);
		if (existing.revision !== expectedRevision) {
			throw new AgentServiceError(
				'SKILL_REVISION_CONFLICT',
				'The skill was changed by another request. Reload before deleting.',
				409,
			);
		}
		if (existing.status !== 'archived') {
			throw new AgentServiceError(
				'SKILL_NOT_ARCHIVED',
				'Archive the skill before deleting it.',
				409,
			);
		}
		const usage = this.repository.skillUsage(trustedTenantId, existing.id);
		if (usage.assignments > 0) {
			throw new AgentServiceError(
				'SKILL_IN_USE',
				'Remove this skill from every agent before deleting it.',
				409,
			);
		}
		if (!this.repository.deleteSkill(trustedTenantId, existing.id)) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent skill not found.',
				404,
			);
		}
		this.repository.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: bounded(actorId, 'actorId', 1, 128),
			action: 'agent-skill.deleted',
			subjectType: 'agent-skill',
			subjectId: existing.id,
			metadata: { key: existing.key, revision: existing.revision },
			occurredAt: this.now(),
		});
	}

	createAgent(
		tenantId: string,
		actorId: string,
		input: CreateAgentInput,
	): AgentDefinition {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const provider = identifier(
			input.provider || (this.settings?.defaultProvider(trustedTenantId) ?? ''),
			'provider',
		);
		const model = bounded(
			input.model || (this.settings?.defaultModel(trustedTenantId) ?? ''),
			'model',
			1,
			160,
		);
		this.assertProviderConfigured(trustedTenantId, provider, model);
		const allowedTools = toolList(input.allowedTools);
		this.assertToolsRegistered(allowedTools);
		const skillIds = skillIdList(input.skillIds);
		this.resolveSkills(trustedTenantId, skillIds, false);
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
			skillIds,
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
			const created = this.repository.createAgent(agent);
			this.repository.appendAuditEvent({
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

	updateAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		input: UpdateAgentInput,
	): AgentDefinition {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const id = bounded(agentId, 'agentId', 1, 128);
		this.#refuseModuleAgentMutation(id);
		const existing = this.repository.getAgent(trustedTenantId, id);
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
		const provider = identifier(
			input.provider || existing.provider,
			'provider',
		);
		const model = bounded(input.model || existing.model, 'model', 1, 160);
		this.assertProviderConfigured(trustedTenantId, provider, model);
		if (input.status === 'active' && this.providerService) {
			this.providerService.assertUsable(trustedTenantId, provider, model);
		}
		const allowedTools = toolList(input.allowedTools);
		this.assertToolsRegistered(allowedTools);
		const skillIds = skillIdList(input.skillIds);
		const skills = this.resolveSkills(
			trustedTenantId,
			skillIds,
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
			skillIds,
			...executionLimits(input, existing.maxOutputTokens),
			status: status(input.status),
			revision: existing.revision + 1,
			updatedBy: identity,
			updatedAt,
		};
		try {
			const result = this.repository.updateAgent(updated);
			this.repository.appendAuditEvent({
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

	archiveAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		expectedRevision: number,
	): AgentDefinition {
		this.#refuseModuleAgentMutation(bounded(agentId, 'agentId', 1, 128));
		const existing = this.requireAgent(tenantId, agentId);
		return this.updateAgent(tenantId, existing.id, actorId, {
			key: existing.key,
			name: existing.name,
			description: existing.description,
			instructions: existing.instructions,
			provider: existing.provider,
			model: existing.model,
			allowedTools: existing.allowedTools,
			skillIds: existing.skillIds,
			maxSteps: existing.maxSteps,
			timeoutMs: existing.timeoutMs,
			temperature: existing.temperature,
			maxOutputTokens: existing.maxOutputTokens,
			status: 'archived',
			expectedRevision,
		});
	}

	deleteAgent(
		tenantId: string,
		agentId: string,
		actorId: string,
		expectedRevision: number,
	): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		this.#refuseModuleAgentMutation(bounded(agentId, 'agentId', 1, 128));
		const existing = this.requireAgent(trustedTenantId, agentId);
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
		const usage = this.repository.agentUsage(trustedTenantId, existing.id);
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
				'Remove every attached skill before deleting this agent.',
				409,
			);
		}
		if (!this.repository.deleteAgent(trustedTenantId, existing.id)) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		this.repository.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: bounded(actorId, 'actorId', 1, 128),
			action: 'agent.deleted',
			subjectType: 'agent',
			subjectId: existing.id,
			metadata: { key: existing.key, revision: existing.revision },
			occurredAt: this.now(),
		});
	}

	listRuns(tenantId: string, limit = 100): readonly AgentRun[] {
		const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
		return this.repository.listRuns(
			bounded(tenantId, 'tenantId', 1, 128),
			boundedLimit,
		);
	}

	getRun(tenantId: string, runId: string): AgentRunDetail {
		const run = this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		if (!run) {
			throw new AgentServiceError('RUN_NOT_FOUND', 'Agent run not found.', 404);
		}
		return run;
	}

	getRevisionReference(
		tenantId: string,
		agentId: string,
		revision: number,
	): {
		readonly agentId: string;
		readonly revision: number;
		readonly name: string;
		readonly status: Exclude<AgentDefinition['status'], 'draft'>;
		readonly supportsStructuredOutput: boolean;
		readonly allowedTools: readonly string[];
	} | null {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		if (!Number.isSafeInteger(revision) || revision < 1) {
			throw new AgentServiceError(
				'INVALID_AGENT_REVISION',
				'revision must be a positive integer.',
			);
		}
		const id = bounded(agentId, 'agentId', 1, 128);
		const retained = this.repository.getAgentRevision(
			trustedTenantId,
			id,
			revision,
		);
		if (!retained || retained.status === 'draft') return null;
		if (retained.ownership.kind === 'module') {
			const definition = this.#moduleAgents.get(id);
			const binding = this.repository.getModuleAgentBinding(
				trustedTenantId,
				id,
			);
			if (
				!definition ||
				!binding ||
				this.#moduleAgentRevisionUnavailableReason(
					trustedTenantId,
					retained,
					binding,
				)
			) {
				return null;
			}
			return {
				agentId: retained.agentId,
				revision: retained.revision,
				name: retained.name,
				status: binding.status,
				supportsStructuredOutput:
					this.providerService?.supportsStructuredOutput(
						trustedTenantId,
						retained.provider,
						retained.model,
					) ?? this.harness.providerSupportsStructuredOutput(retained.provider),
				allowedTools: retained.allowedTools,
			};
		}
		const current = this.repository.getAgent(trustedTenantId, id);
		if (!current || current.status === 'draft') return null;
		return {
			agentId: retained.agentId,
			revision: retained.revision,
			name: retained.name,
			status: current.status === 'active' ? retained.status : current.status,
			supportsStructuredOutput:
				this.providerService?.supportsStructuredOutput(
					trustedTenantId,
					retained.provider,
					retained.model,
				) ?? this.harness.providerSupportsStructuredOutput(retained.provider),
			allowedTools: retained.allowedTools,
		};
	}

	listRevisionReferences(tenantId: string): readonly {
		readonly agentId: string;
		readonly revision: number;
		readonly name: string;
		readonly status: Exclude<AgentDefinition['status'], 'draft'>;
		readonly supportsStructuredOutput: boolean;
		readonly allowedTools: readonly string[];
	}[] {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const current = new Map(
			this.repository
				.listAgents(trustedTenantId)
				.map((agent) => [agent.id, agent] as const),
		);
		const moduleBindings = new Map(
			this.repository
				.listModuleAgentBindings(trustedTenantId)
				.map((binding) => [binding.agentId, binding] as const),
		);
		return this.repository
			.listAgentRevisions(trustedTenantId)
			.flatMap((retained) => {
				if (retained.ownership.kind === 'module') {
					const definition = this.#moduleAgents.get(retained.agentId);
					const binding = moduleBindings.get(retained.agentId);
					if (
						!definition ||
						!binding ||
						this.#moduleAgentRevisionUnavailableReason(
							trustedTenantId,
							retained,
							binding,
						)
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
								this.providerService?.supportsStructuredOutput(
									trustedTenantId,
									retained.provider,
									retained.model,
								) ??
								this.harness.providerSupportsStructuredOutput(
									retained.provider,
								),
							allowedTools: retained.allowedTools,
						},
					];
				}
				const agent = current.get(retained.agentId);
				if (!agent || agent.status === 'draft' || retained.status === 'draft') {
					return [];
				}
				return [
					{
						agentId: retained.agentId,
						revision: retained.revision,
						name: retained.name,
						status: agent.status === 'active' ? retained.status : agent.status,
						supportsStructuredOutput:
							this.providerService?.supportsStructuredOutput(
								trustedTenantId,
								retained.provider,
								retained.model,
							) ??
							this.harness.providerSupportsStructuredOutput(retained.provider),
						allowedTools: retained.allowedTools,
					},
				];
			});
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
		const existing = this.repository.findRunByIdempotencyKey(
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
		const retained = this.repository.getAgentRevision(
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
			const binding = this.repository.getModuleAgentBinding(
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
			const unavailable = this.#moduleAgentRevisionUnavailableReason(
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
			const current = this.repository.getAgent(trustedTenantId, agentId);
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
			this.providerService?.supportsStructuredOutput(
				trustedTenantId,
				retained.provider,
				retained.model,
			) ?? this.harness.providerSupportsStructuredOutput(retained.provider);
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
		const missingSkillGrant = retained.skills
			.flatMap((skill) => skill.requiredTools)
			.find((tool) => !effectiveToolGrants.includes(tool));
		if (missingSkillGrant) {
			throw new AgentServiceError(
				'SKILL_TOOL_GRANT_REQUIRED',
				`Skill requires permission for tool ${missingSkillGrant}.`,
				403,
			);
		}
		const refusal = this.budget?.check(
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
			...retained.skills.map(
				(skill) =>
					`\n[Approved skill: ${skill.key} revision ${skill.revision}]\n${skill.instructions}`,
			),
		].join('\n');
		if (instructions.length > 40_000) {
			throw new AgentServiceError(
				'AGENT_INSTRUCTIONS_TOO_LARGE',
				'Agent and skill instructions exceed the 40000 character execution limit.',
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
			skillSnapshots: retained.skills.map((skill) => ({
				id: skill.id,
				key: skill.key,
				name: skill.name,
				revision: skill.revision,
				requiredTools: skill.requiredTools,
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
			this.repository.enqueueRun(
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
				const raced = this.repository.findRunByIdempotencyKey(
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

	getWorkflowRun(
		tenantId: string,
		workflowRunId: string,
		runId: string,
	): AgentRunDetail | null {
		const run = this.repository.getRun(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(runId, 'runId', 1, 128),
		);
		return run?.workflowRunId ===
			bounded(workflowRunId, 'workflowRunId', 1, 128)
			? run
			: null;
	}

	readWorkflowRunEvents(
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
		const run = this.getWorkflowRun(tenantId, workflowRunId, runId);
		return run
			? this.repository.listRunEvents(run.tenantId, run.id, afterSequence)
			: [];
	}

	cancelWorkflowRun(
		context: {
			readonly tenantId: string;
			readonly workflowRunId: string;
			readonly actor: Actor;
			readonly permissionSnapshot: readonly string[];
		},
		runId: string,
	): boolean {
		const actor = normalizeActor(context.actor);
		if (!actor) {
			throw new AgentServiceError('INVALID_ACTOR', 'Actor is invalid.');
		}
		const run = this.getWorkflowRun(
			context.tenantId,
			context.workflowRunId,
			runId,
		);
		if (!run) return false;
		if (TERMINAL_STATUSES.includes(run.status)) return false;
		this.cancelRun(context.tenantId, actor, context.permissionSnapshot, run.id);
		return true;
	}

	/* The served shape of one run: stored events folded into timeline entries.
	   Every reader goes through here, so the run screen and any other consumer
	   see the same grouping and the same ceiling. */
	getRunTimeline(tenantId: string, runId: string): AgentRunTimeline {
		const { events, ...run } = this.getRun(tenantId, runId);
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
			const existing = this.repository.findRunByIdempotencyKey(
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
		const agent = this.#currentExecutionAgent(trustedTenantId, agentId);
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
		const skills = this.resolveSkills(trustedTenantId, agent.skillIds, true);
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
			.flatMap((skill) => skill.requiredTools)
			.find((tool) => !effectiveToolGrants.includes(tool));
		if (missingSkillGrant) {
			throw new AgentServiceError(
				'SKILL_TOOL_GRANT_REQUIRED',
				`Skill requires explicit run grant for tool ${missingSkillGrant}.`,
				403,
			);
		}
		const refusal = this.budget?.check(trustedTenantId, agent.id, this.now());
		if (refusal) {
			throw new AgentServiceError(refusal.code, refusal.message, 409);
		}
		await this.providerService?.ensureUsable(
			trustedTenantId,
			agent.provider,
			agent.model,
			identity,
		);
		const skillSnapshots: readonly AgentSkillSnapshot[] = skills.map(
			(skill) => ({
				id: skill.id,
				key: skill.key,
				name: skill.name,
				revision: skill.revision,
				requiredTools: skill.requiredTools,
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
				(skill) =>
					`\n[Approved skill: ${skill.key} revision ${skill.revision}]\n${skill.instructions}`,
			),
		].join('\n');
		if (instructions.length > 40_000) {
			throw new AgentServiceError(
				'AGENT_INSTRUCTIONS_TOO_LARGE',
				'Agent and skill instructions exceed the 40000 character execution limit.',
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
			skillSnapshots,
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
			queued = this.repository.enqueueRun(
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
				const existing = this.repository.findRunByIdempotencyKey(
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
	cancelRun(
		tenantId: string,
		actorInput: Actor | string,
		permissionSnapshot: readonly string[],
		runId: string,
	): AgentRunTimeline {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = requestedActor(actorInput);
		const identity = actor.id;
		const id = bounded(runId, 'runId', 1, 128);
		const run = this.getRun(trustedTenantId, id);
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
		const previousStatus = this.repository.cancelRun(
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
		return this.getRunTimeline(trustedTenantId, id);
	}

	private assertProviderConfigured(
		tenantId: string,
		providerId: string,
		modelId: string,
	): void {
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
		const provider = this.providerService.get(tenantId, providerId);
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

	#moduleAgentUnavailableReason(
		tenantId: string,
		definition: ModuleAgentDefinition,
		binding: ModuleAgentBinding,
	): string | null {
		const missingTool = binding.enabledTools.find(
			(tool) =>
				!definition.allowedTools.includes(tool) ||
				!this.harness.tools().includes(tool),
		);
		if (missingTool) return `Tool ${missingTool} is not available.`;
		try {
			this.assertProviderConfigured(tenantId, binding.provider, binding.model);
			if (binding.status === 'active' && this.providerService) {
				this.providerService.assertUsable(
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
	#moduleAgentRevisionUnavailableReason(
		tenantId: string,
		revision: AgentDefinitionRevision,
		binding: ModuleAgentBinding,
	): string | null {
		const missingTool = revision.allowedTools.find(
			(tool) => !this.harness.tools().includes(tool),
		);
		if (missingTool) return `Tool ${missingTool} is not available.`;
		try {
			this.assertProviderConfigured(
				tenantId,
				revision.provider,
				revision.model,
			);
			if (binding.status === 'active' && this.providerService) {
				this.providerService.assertUsable(
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

	#moduleAgentView(
		tenantId: string,
		definition: ModuleAgentDefinition,
		binding: ModuleAgentBinding | null,
	): ModuleAgentView {
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
		const unavailableReason = this.#moduleAgentUnavailableReason(
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

	#currentExecutionAgent(
		tenantId: string,
		agentId: string,
	): AgentDefinition | null {
		const tenantAgent = this.repository.getAgent(tenantId, agentId);
		if (tenantAgent) return tenantAgent;
		const definition = this.#moduleAgents.get(agentId);
		if (!definition) return null;
		const binding = this.repository.getModuleAgentBinding(tenantId, agentId);
		if (!binding) {
			throw new AgentServiceError(
				'MODULE_AGENT_UNCONFIGURED',
				'Configure a provider and model before running this module agent.',
				409,
			);
		}
		const unavailable = this.#moduleAgentUnavailableReason(
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
			skillIds: [],
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

	private requireAgent(tenantId: string, agentId: string): AgentDefinition {
		const agent = this.repository.getAgent(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(agentId, 'agentId', 1, 128),
		);
		if (!agent) {
			throw new AgentServiceError('AGENT_NOT_FOUND', 'Agent not found.', 404);
		}
		return agent;
	}

	private requireSkill(tenantId: string, skillId: string): AgentSkill {
		const skill = this.repository.getSkill(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(skillId, 'skillId', 1, 128),
		);
		if (!skill) {
			throw new AgentServiceError(
				'SKILL_NOT_FOUND',
				'Agent skill not found.',
				404,
			);
		}
		return skill;
	}

	private assertSkillCanArchive(tenantId: string, skillId: string): void {
		const usage = this.repository.skillUsage(tenantId, skillId);
		if (usage.activeDefinitions > 0) {
			throw new AgentServiceError(
				'SKILL_IN_USE',
				'Remove this skill from every active agent before archiving it.',
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

	private resolveSkills(
		tenantId: string,
		skillIds: readonly string[],
		requireActive: boolean,
	): readonly AgentSkill[] {
		return skillIds.map((skillId) => {
			const skill = this.repository.getSkill(tenantId, skillId);
			if (!skill) {
				throw new AgentServiceError(
					'SKILL_NOT_FOUND',
					'Attached agent skill was not found in the active tenant.',
					409,
				);
			}
			if (requireActive && skill.status !== 'active') {
				throw new AgentServiceError(
					'SKILL_NOT_ACTIVE',
					`Skill ${skill.key} must be active before the agent can run.`,
					409,
				);
			}
			return skill;
		});
	}

	private assertSkillToolsAllowed(
		skills: readonly AgentSkill[],
		allowedTools: readonly string[],
	): void {
		const unavailable = skills
			.flatMap((skill) => skill.requiredTools)
			.find((tool) => !allowedTools.includes(tool));
		if (unavailable) {
			throw new AgentServiceError(
				'SKILL_TOOL_NOT_ALLOWED',
				`Attached skill requires ${unavailable}, which the agent does not allow.`,
				409,
			);
		}
	}
}
