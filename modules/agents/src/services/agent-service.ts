import { randomUUID } from 'node:crypto';
import type { AgentHarness, AgentRunTrigger } from '@coreloom/harness';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentRun,
	AgentRunDetail,
	AgentSkill,
	AgentSkillSnapshot,
	AgentWorkerStatus,
	CreateAgentSkillInput,
	CreateAgentInput,
	EnqueueAgentRunInput,
	UpdateAgentSkillInput,
	UpdateAgentInput,
} from '../domain/types.ts';
import type { AgentSettingsReader } from '../settings.ts';
import {
	DuplicateAgentKeyError,
	DuplicateAgentSkillKeyError,
	DuplicateRunIdempotencyKeyError,
	type AgentRepository,
} from './repository.ts';
import type { AgentProviderService } from './provider-service.ts';
import type { AgentWorker } from './worker.ts';

const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const TERMINAL_STATUSES: readonly AgentRun['status'][] = [
	'succeeded',
	'failed',
	'cancelled',
];

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

export class AgentService {
	constructor(
		private readonly repository: AgentRepository,
		private readonly harness: AgentHarness,
		private readonly worker: AgentWorker,
		private readonly providerService?: AgentProviderService,
		private readonly now: () => number = Date.now,
		private readonly settings?: AgentSettingsReader,
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

	listAgents(tenantId: string): readonly AgentDefinition[] {
		return this.repository.listAgents(bounded(tenantId, 'tenantId', 1, 128));
	}

	listSkills(tenantId: string): readonly AgentSkill[] {
		return this.repository.listSkills(bounded(tenantId, 'tenantId', 1, 128));
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
				action: 'agent-skill.updated',
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
				action: 'agent.updated',
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

	async enqueueRun(
		tenantId: string,
		actorId: string,
		permissionSnapshot: readonly string[],
		input: EnqueueAgentRunInput,
	): Promise<AgentRun> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const identity = bounded(actorId, 'actorId', 1, 128);
		const idempotencyKey = input.idempotencyKey
			? bounded(input.idempotencyKey, 'idempotencyKey', 8, 128)
			: null;
		if (idempotencyKey) {
			const existing = this.repository.findRunByIdempotencyKey(
				trustedTenantId,
				idempotencyKey,
			);
			if (existing) return existing;
		}
		const agent = this.repository.getAgent(
			trustedTenantId,
			bounded(input.agentId, 'agentId', 1, 128),
		);
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
		await this.providerService?.ensureUsable(
			trustedTenantId,
			agent.provider,
			agent.model,
			identity,
		);
		const skills = this.resolveSkills(trustedTenantId, agent.skillIds, true);
		this.assertSkillToolsAllowed(skills, agent.allowedTools);
		const toolGrants = toolList(input.toolGrants);
		const invalidGrant = toolGrants.find(
			(tool) => !agent.allowedTools.includes(tool),
		);
		if (invalidGrant) {
			throw new AgentServiceError(
				'TOOL_NOT_ALLOWED',
				`Tool ${invalidGrant} is not allowed by the agent definition.`,
				403,
			);
		}
		const missingSkillGrant = skills
			.flatMap((skill) => skill.requiredTools)
			.find((tool) => !toolGrants.includes(tool));
		if (missingSkillGrant) {
			throw new AgentServiceError(
				'SKILL_TOOL_GRANT_REQUIRED',
				`Skill requires explicit run grant for tool ${missingSkillGrant}.`,
				403,
			);
		}
		const skillSnapshots: readonly AgentSkillSnapshot[] = skills.map(
			(skill) => ({
				id: skill.id,
				key: skill.key,
				name: skill.name,
				revision: skill.revision,
				requiredTools: skill.requiredTools,
			}),
		);
		const instructions = [
			agent.instructions,
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
			trigger: trigger(input.trigger),
			status: 'queued',
			input: bounded(input.input, 'input', 1, 100_000),
			output: null,
			provider: agent.provider,
			model: agent.model,
			requestedBy: identity,
			permissionSnapshot: [...new Set(permissionSnapshot)].sort(),
			toolGrants,
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
			);
		} catch (error) {
			/* Two callers raced past the lookup with the same key; the row that
			   won is the run they both asked for. */
			if (error instanceof DuplicateRunIdempotencyKeyError && idempotencyKey) {
				const existing = this.repository.findRunByIdempotencyKey(
					trustedTenantId,
					idempotencyKey,
				);
				if (existing) return existing;
			}
			throw error;
		}
		this.repository.appendAuditEvent({
			tenantId: queued.tenantId,
			actorId: identity,
			action: 'agent-run.queued',
			subjectType: 'agent-run',
			subjectId: queued.id,
			metadata: {
				agentId: queued.agentId,
				agentRevision: queued.agentRevision,
				trigger: queued.trigger,
			},
			occurredAt: queuedAt,
		});
		this.worker.kick();
		return queued;
	}

	/* The requester may cancel their own run; a definitions manager may cancel
	   any run in the tenant. */
	cancelRun(
		tenantId: string,
		actorId: string,
		permissionSnapshot: readonly string[],
		runId: string,
	): AgentRunDetail {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const identity = bounded(actorId, 'actorId', 1, 128);
		const id = bounded(runId, 'runId', 1, 128);
		const run = this.getRun(trustedTenantId, id);
		if (
			run.requestedBy !== identity &&
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
		);
		if (previousStatus === null) {
			throw new AgentServiceError(
				'RUN_ALREADY_FINISHED',
				'The run finished before it could be cancelled.',
				409,
			);
		}
		this.worker.cancel(id);
		this.repository.appendAuditEvent({
			tenantId: trustedTenantId,
			actorId: identity,
			action: 'agent-run.cancelled',
			subjectType: 'agent-run',
			subjectId: id,
			metadata: { previousStatus },
			occurredAt: cancelledAt,
		});
		return this.getRun(trustedTenantId, id);
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
