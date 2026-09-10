import { createHash, randomUUID } from 'node:crypto';
import {
	normalizeActor,
	serviceActor,
	VariableResolutionError,
	type Actor,
	type PlatformVariableRegistry,
	type UserActor,
} from '@flowdular/kernel';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import type {
	AutomationSchedule,
	AutomationTargetOption,
	CreateAutomationScheduleInput,
	UpdateAutomationScheduleInput,
} from '../domain/types.ts';
import {
	createScheduleVariableRegistry,
	resolveScheduleTemplate,
	validateScheduleTemplate,
} from '../domain/variables.ts';
import {
	InvalidCadenceError,
	cadenceMinutes,
	nextSlotAfter,
	normalizeCadence,
} from '../domain/cadence.ts';
import {
	createAutomationTargetRegistry,
	type AutomationTargetJsonValue,
	type AutomationTargetRegistry,
} from '../server/targets.ts';
import { AutomationsServiceError } from './automations-service.ts';
import type {
	AutomationsRepository,
	StoredAutomationSchedule,
} from './repository.ts';

const MAX_ERROR_LENGTH = 200;

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AutomationsServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new AutomationsServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

function cadence(value: string): string {
	try {
		return normalizeCadence(value);
	} catch (error) {
		if (error instanceof InvalidCadenceError) {
			throw new AutomationsServiceError('INVALID_CADENCE', error.message);
		}
		throw error;
	}
}

function trustedUser(input: string | UserActor): UserActor {
	if (typeof input === 'string') {
		const id = bounded(input, 'actorId', 1, 128);
		return { kind: 'user', id, label: id };
	}
	const actor = normalizeActor(input);
	if (!actor || actor.kind !== 'user') {
		throw new AutomationsServiceError('INVALID_ACTOR', 'Actor is invalid.');
	}
	return actor;
}

function targetSelection(input: {
	readonly targetKind?: string;
	readonly targetKey?: string;
	readonly agentId?: string;
}): { readonly kind: string; readonly key: string } {
	const kind = bounded(input.targetKind ?? 'agent', 'targetKind', 2, 64);
	const key = bounded(
		input.targetKey ?? input.agentId ?? '',
		'targetKey',
		1,
		128,
	);
	if (
		kind === 'agent' &&
		input.targetKey &&
		input.agentId &&
		input.targetKey !== input.agentId
	) {
		throw new AutomationsServiceError(
			'INVALID_INPUT',
			'Agent target identifiers do not match.',
		);
	}
	return { kind, key };
}

function sortedScopes(scopes: readonly string[]): readonly string[] {
	return [...new Set(scopes)].sort();
}

function parsedJson(value: string): AutomationTargetJsonValue {
	try {
		return JSON.parse(value) as AutomationTargetJsonValue;
	} catch {
		throw new AutomationsServiceError(
			'AUTOMATION_TARGET_INPUT_INVALID',
			'Workflow automation input must resolve to valid JSON.',
		);
	}
}

function failureCode(error: unknown, fallback: string): string {
	return typeof (error as { code?: unknown })?.code === 'string'
		? String((error as { code: string }).code)
		: fallback;
}

function serviceFailure(
	error: unknown,
	fallback: string,
): AutomationsServiceError {
	if (error instanceof AutomationsServiceError) return error;
	const code = failureCode(error, fallback);
	const status =
		typeof (error as { status?: unknown })?.status === 'number'
			? Number((error as { status: number }).status)
			: 409;
	return new AutomationsServiceError(
		code,
		error instanceof Error ? error.message : 'The automation target refused.',
		status,
	);
}

function disablesTarget(code: string): boolean {
	return (
		code === 'AGENT_NOT_FOUND' ||
		code === 'AGENT_NOT_ACTIVE' ||
		code === 'AUTOMATION_TARGET_UNAVAILABLE' ||
		code === 'AUTOMATION_TARGET_NOT_FOUND' ||
		code === 'WORKFLOW_NOT_FOUND' ||
		code === 'WORKFLOW_ARCHIVED' ||
		code === 'WORKFLOW_NOT_PUBLISHED' ||
		code === 'WORKFLOW_PERMISSION_DENIED'
	);
}

export function scheduleSlotKey(scheduleId: string, slot: number): string {
	return `schedule:${scheduleId}:${slot}`;
}

function manualRequestToken(actor: Actor, now: number): string {
	const actorKey = createHash('sha256')
		.update(JSON.stringify([actor.kind, actor.id]))
		.digest('hex')
		.slice(0, 16);
	return `${actorKey}:${Math.floor(now / 10_000)}`;
}

function manualRunKey(scheduleId: string, actor: Actor, now: number): string {
	return `schedule-now:${scheduleId}:${manualRequestToken(actor, now)}`;
}

export interface AutomationRunNowOptions {
	/* A caller that owns a durable retry supplies its own attempt independent
	   key, so the agent run ledger returns the first run instead of firing the
	   schedule again. It reaches the agent dispatch path only. */
	readonly idempotencyKey?: string;
	/* Target kinds this caller can dispatch. Absent means every kind. */
	readonly allowedTargetKinds?: readonly string[];
}

export interface AutomationScheduleRunOutcome {
	readonly id: string;
	readonly created: boolean;
	readonly targetKind: string;
}

export class AutomationScheduleService {
	private readonly variables: PlatformVariableRegistry;
	private readonly targets: AutomationTargetRegistry;

	constructor(
		private readonly repository: AutomationsRepository,
		private readonly runs: AgentRunQueue,
		private readonly now: () => number = Date.now,
		private readonly signal: AbortSignal = new AbortController().signal,
		variables?: PlatformVariableRegistry,
		targets?: AutomationTargetRegistry,
	) {
		this.variables = variables ?? createScheduleVariableRegistry(this.runs);
		this.targets = targets ?? createAutomationTargetRegistry();
	}

	async list(tenantId: string): Promise<readonly AutomationSchedule[]> {
		return Promise.all(
			(await this.repository.listSchedules(tenantId)).map((record) =>
				this.present(record),
			),
		);
	}

	async agents(tenantId: string) {
		return (await this.runs.listAgents(tenantId)).map(
			({ id, name, status }) => ({ id, name, status }),
		);
	}

	async targetOptions(
		tenantId: string,
		actorInput: string | UserActor,
		permissionSnapshot: readonly string[],
	): Promise<readonly AutomationTargetOption[]> {
		const actor = trustedUser(actorInput);
		const agents: AutomationTargetOption[] = (await this.agents(tenantId))
			.filter((agent) => agent.status === 'active')
			.map((agent) => ({
				kind: 'agent',
				key: agent.id,
				label: agent.name,
				available: true,
			}));
		const extensions = [];
		for (const adapter of this.targets.list()) {
			if (!adapter.available()) continue;
			try {
				extensions.push(
					...(await adapter.list({ tenantId, actor, permissionSnapshot })).map(
						(target) => ({
							...target,
							kind: adapter.kind,
							available: true,
						}),
					),
				);
			} catch {
				/* A revoked permission hides that adapter's targets, it does not
				   hide the agent targets the caller may still use. */
			}
		}
		return [...agents, ...extensions];
	}

	async get(tenantId: string, scheduleId: string): Promise<AutomationSchedule> {
		const schedule = await this.repository.getSchedule(
			tenantId,
			bounded(scheduleId, 'scheduleId', 1, 128),
		);
		if (!schedule) {
			throw new AutomationsServiceError(
				'SCHEDULE_NOT_FOUND',
				'Automation schedule not found.',
				404,
			);
		}
		return await this.present(schedule);
	}

	async create(
		tenantId: string,
		actorInput: string | UserActor,
		input: CreateAutomationScheduleInput,
		scopes: readonly string[] = [],
	): Promise<AutomationSchedule> {
		const now = this.now();
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const configuredBy = trustedUser(actorInput);
		const target = targetSelection(input);
		await this.validateTarget(trustedTenantId, target, configuredBy, scopes);
		const normalized = cadence(input.cadence);
		const inputTemplate = bounded(input.inputTemplate, 'input', 1, 10_000);
		validateScheduleTemplate(inputTemplate, scopes);
		if (
			target.kind !== 'agent' &&
			/{{\s*agent\.name\s*}}/.test(inputTemplate)
		) {
			throw new AutomationsServiceError(
				'FORBIDDEN_TEMPLATE_VARIABLE',
				'Workflow targets cannot use the agent.name variable.',
				403,
			);
		}
		const schedule: StoredAutomationSchedule = {
			id: randomUUID(),
			tenantId: trustedTenantId,
			targetKind: target.kind,
			targetKey: target.key,
			agentId: target.kind === 'agent' ? target.key : '',
			label: bounded(input.label, 'label', 2, 120),
			inputTemplate,
			cadence: normalized,
			enabled: input.enabled === true,
			disabledReason: null,
			nextRunAt: now + cadenceMinutes(normalized) * 60_000,
			lastRunAt: null,
			lastRunId: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
			createdBy: configuredBy.id,
			configuredBy,
			permissionSnapshot: sortedScopes(scopes),
		};
		const created = await this.present(
			await this.repository.createSchedule(schedule),
		);
		await this.audit(
			created,
			configuredBy.id,
			'automation-schedule.created',
			now,
			{
				targetKind: created.targetKind,
				targetKey: created.targetKey,
				cadence: created.cadence,
				enabled: created.enabled,
			},
		);
		return created;
	}

	async update(
		tenantId: string,
		actorInput: string | UserActor,
		input: UpdateAutomationScheduleInput,
		scopes: readonly string[] = [],
	): Promise<AutomationSchedule> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = await this.repository.getSchedule(
			trustedTenantId,
			bounded(input.id, 'scheduleId', 1, 128),
		);
		if (!existing) {
			throw new AutomationsServiceError(
				'SCHEDULE_NOT_FOUND',
				'Automation schedule not found.',
				404,
			);
		}
		const configuredBy = trustedUser(actorInput);
		const target = targetSelection(input);
		await this.validateTarget(trustedTenantId, target, configuredBy, scopes);
		const now = this.now();
		const nextCadence = cadence(input.cadence);
		const nextRunAt =
			nextCadence === existing.cadence && existing.enabled === input.enabled
				? existing.nextRunAt
				: now + cadenceMinutes(nextCadence) * 60_000;
		const inputTemplate = bounded(input.inputTemplate, 'input', 1, 10_000);
		validateScheduleTemplate(inputTemplate, scopes);
		if (
			target.kind !== 'agent' &&
			/{{\s*agent\.name\s*}}/.test(inputTemplate)
		) {
			throw new AutomationsServiceError(
				'FORBIDDEN_TEMPLATE_VARIABLE',
				'Workflow targets cannot use the agent.name variable.',
				403,
			);
		}
		const updated = await this.present(
			await this.repository.updateSchedule({
				...existing,
				targetKind: target.kind,
				targetKey: target.key,
				agentId: target.kind === 'agent' ? target.key : '',
				label: bounded(input.label, 'label', 2, 120),
				inputTemplate,
				cadence: nextCadence,
				enabled: input.enabled === true,
				disabledReason: input.enabled ? null : existing.disabledReason,
				nextRunAt,
				updatedAt: now,
				configuredBy,
				permissionSnapshot: sortedScopes(scopes),
			}),
		);
		await this.audit(
			updated,
			configuredBy.id,
			'automation-schedule.updated',
			now,
			{
				targetKind: updated.targetKind,
				targetKey: updated.targetKey,
				cadence: updated.cadence,
				enabled: updated.enabled,
			},
		);
		return updated;
	}

	async delete(
		tenantId: string,
		actorId: string,
		scheduleId: string,
	): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const existing = await this.get(trustedTenantId, scheduleId);
		const now = this.now();
		await this.repository.deleteSchedule(trustedTenantId, existing.id);
		await this.audit(existing, actorId, 'automation-schedule.deleted', now, {
			targetKind: existing.targetKind,
			targetKey: existing.targetKey,
		});
	}

	async runNow(
		tenantId: string,
		actorInput: Actor,
		scheduleId: string,
		permissionSnapshot: readonly string[] = [AUTOMATIONS_PERMISSIONS.manage],
		options: AutomationRunNowOptions = {},
	): Promise<AutomationScheduleRunOutcome> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const actor = normalizeActor(actorInput);
		if (!actor) {
			throw new AutomationsServiceError('INVALID_ACTOR', 'Actor is invalid.');
		}
		const stored = await this.repository.getSchedule(
			trustedTenantId,
			bounded(scheduleId, 'scheduleId', 1, 128),
		);
		if (!stored) {
			throw new AutomationsServiceError(
				'SCHEDULE_NOT_FOUND',
				'Automation schedule not found.',
				404,
			);
		}
		/* The allowlist is checked against the stored row that dispatch uses, so a
		   caller cannot be routed to a target kind it refused. */
		if (
			options.allowedTargetKinds &&
			!options.allowedTargetKinds.includes(stored.targetKind)
		) {
			throw new AutomationsServiceError(
				'AUTOMATION_TARGET_KIND_DENIED',
				`This caller cannot run a ${stored.targetKind} automation target.`,
				409,
			);
		}
		const now = this.now();
		let id: string;
		let created: boolean;
		if (stored.targetKind === 'agent') {
			const agent = await this.requireAgent(trustedTenantId, stored.targetKey);
			const accepted = await this.runs.enqueueWithOutcome(
				{ tenantId: trustedTenantId, actor, permissionSnapshot },
				{
					agentId: stored.targetKey,
					trigger: 'schedule',
					input: await this.resolvedInput(
						stored,
						now,
						actor,
						permissionSnapshot,
					),
					toolGrants: agent.allowedTools,
					idempotencyKey:
						options.idempotencyKey === undefined
							? manualRunKey(stored.id, actor, now)
							: bounded(options.idempotencyKey, 'idempotencyKey', 8, 128),
				},
			);
			id = accepted.run.id;
			created = accepted.created;
		} else {
			if (options.idempotencyKey !== undefined) {
				throw new AutomationsServiceError(
					'AUTOMATION_IDEMPOTENCY_UNSUPPORTED',
					`A caller supplied idempotency key does not reach a ${stored.targetKind} target.`,
					409,
				);
			}
			if (actor.kind !== 'user') {
				throw new AutomationsServiceError(
					'INVALID_ACTOR',
					'Run now requires a user actor.',
					403,
				);
			}
			let result;
			try {
				result = await this.requireTargetAdapter(stored.targetKind).invoke(
					{
						targetKey: stored.targetKey,
						input: parsedJson(
							await this.resolvedInput(stored, now, actor, permissionSnapshot),
						),
					},
					{
						tenantId: trustedTenantId,
						configuredBy: actor,
						permissionSnapshot: sortedScopes(permissionSnapshot),
						source: {
							kind: 'run-now',
							scheduleId: stored.id,
							requestId: manualRequestToken(actor, now),
							actor,
						},
					},
				);
			} catch (error) {
				throw serviceFailure(error, 'AUTOMATION_TARGET_REFUSED');
			}
			id = result.correlationId;
			created = result.created;
		}
		if (created) {
			await this.repository.appendAuditEvent({
				tenantId: trustedTenantId,
				actorId: actor.id,
				action: 'automation-schedule.fired',
				subjectType: 'automation-schedule',
				subjectId: stored.id,
				metadata: {
					runId: id,
					manual: true,
					targetKind: stored.targetKind,
				},
				occurredAt: now,
			});
		}
		return { id, created, targetKind: stored.targetKind };
	}

	async tick(limit = 20): Promise<number> {
		const now = this.now();
		const due = await this.repository.listDueSchedules(now, limit);
		let fired = 0;
		for (const routing of due) {
			/* The poll crosses tenants and returns routing data only. The schedule
			   itself is read under the tenant that row named, and a slot that moved
			   in between is skipped rather than fired twice. */
			const schedule = await this.repository.getSchedule(
				routing.tenantId,
				routing.id,
			);
			if (!schedule || schedule.nextRunAt !== routing.nextRunAt) continue;
			if (await this.fire(schedule, now)) fired += 1;
		}
		return fired;
	}

	private async fire(
		schedule: StoredAutomationSchedule,
		now: number,
	): Promise<boolean> {
		const slot = schedule.nextRunAt;
		let runId: string | null = null;
		let failure: string | null = null;
		try {
			if (schedule.targetKind === 'agent') {
				const actor = serviceActor({
					serviceId: `schedule:${schedule.id}`,
					label: `Schedule: ${schedule.label}`,
					configuredBy: schedule.configuredBy,
				});
				const run = await this.runs.enqueue(
					{ tenantId: schedule.tenantId, actor, permissionSnapshot: [] },
					{
						agentId: schedule.targetKey,
						trigger: 'schedule',
						input: await this.resolvedInput(schedule, now, actor, [
							AUTOMATIONS_PERMISSIONS.manage,
						]),
						toolGrants: [],
						idempotencyKey: scheduleSlotKey(schedule.id, slot),
					},
				);
				runId = run.id;
			} else {
				const actor = serviceActor({
					serviceId: 'automations.core',
					label: 'Automations',
					configuredBy: schedule.configuredBy,
				});
				const result = await this.requireTargetAdapter(
					schedule.targetKind,
				).invoke(
					{
						targetKey: schedule.targetKey,
						input: parsedJson(
							await this.resolvedInput(
								schedule,
								now,
								actor,
								schedule.permissionSnapshot,
							),
						),
					},
					{
						tenantId: schedule.tenantId,
						configuredBy: schedule.configuredBy,
						permissionSnapshot: schedule.permissionSnapshot,
						source: { kind: 'schedule', scheduleId: schedule.id, slot },
					},
				);
				runId = result.correlationId;
			}
		} catch (error) {
			const code = failureCode(error, 'SCHEDULE_FIRE_FAILED');
			failure = `${code}: ${
				error instanceof Error ? error.message : 'The scheduled run failed.'
			}`.slice(0, MAX_ERROR_LENGTH);
			if (disablesTarget(code)) {
				if (
					await this.repository.disableSchedule(
						schedule.tenantId,
						schedule.id,
						failure,
						now,
					)
				) {
					await this.audit(
						schedule,
						'system',
						'automation-schedule.disabled',
						now,
						{
							reason: code,
							targetKind: schedule.targetKind,
						},
					);
				}
				return false;
			}
		}
		const advanced = await this.repository.advanceSchedule({
			tenantId: schedule.tenantId,
			scheduleId: schedule.id,
			firedSlot: slot,
			nextRunAt: nextSlotAfter(slot, cadenceMinutes(schedule.cadence), now),
			lastRunAt: now,
			lastRunId: runId ?? schedule.lastRunId,
			lastError: failure,
		});
		if (!advanced) return false;
		await this.audit(
			schedule,
			'system',
			runId ? 'automation-schedule.fired' : 'automation-schedule.refused',
			now,
			runId
				? { runId, slot, targetKind: schedule.targetKind }
				: {
						slot,
						reason: failure ?? 'unknown',
						targetKind: schedule.targetKind,
					},
		);
		return runId !== null;
	}

	private async validateTarget(
		tenantId: string,
		target: { readonly kind: string; readonly key: string },
		actor: UserActor,
		permissionSnapshot: readonly string[],
	): Promise<void> {
		if (target.kind === 'agent') {
			await this.requireAgent(tenantId, target.key);
			return;
		}
		try {
			await this.requireTargetAdapter(target.kind).validate(target.key, {
				tenantId,
				actor,
				permissionSnapshot: sortedScopes(permissionSnapshot),
			});
		} catch (error) {
			throw serviceFailure(error, 'AUTOMATION_TARGET_REFUSED');
		}
	}

	private requireTargetAdapter(kind: string) {
		const adapter = this.targets.get(kind);
		if (!adapter || !adapter.available()) {
			throw new AutomationsServiceError(
				'AUTOMATION_TARGET_UNAVAILABLE',
				`The ${kind} automation target is unavailable.`,
				503,
			);
		}
		return adapter;
	}

	private async requireAgent(tenantId: string, agentId: string) {
		const agent = (await this.runs.listAgents(tenantId)).find(
			(candidate) => candidate.id === agentId,
		);
		if (!agent) {
			throw new AutomationsServiceError(
				'AGENT_NOT_FOUND',
				'Agent not found.',
				404,
			);
		}
		return agent;
	}

	private async resolvedInput(
		schedule: Pick<
			StoredAutomationSchedule,
			'tenantId' | 'agentId' | 'id' | 'label' | 'inputTemplate' | 'targetKind'
		>,
		now: number,
		actor: Actor,
		permissionSnapshot: readonly string[],
	): Promise<string> {
		try {
			return await resolveScheduleTemplate(
				this.variables,
				schedule.inputTemplate,
				schedule,
				now,
				actor,
				permissionSnapshot,
				this.signal,
			);
		} catch (error) {
			if (error instanceof VariableResolutionError) {
				const agentMissing =
					schedule.targetKind === 'agent' &&
					error.code !== 'VARIABLE_RESOLUTION_ABORTED' &&
					!(await this.runs.listAgents(schedule.tenantId)).some(
						(agent) => agent.id === schedule.agentId,
					);
				if (agentMissing) {
					throw new AutomationsServiceError(
						'AGENT_NOT_FOUND',
						'Agent not found.',
						404,
					);
				}
				throw new AutomationsServiceError(
					error.code,
					'Schedule input variables could not be resolved.',
					error.code === 'FORBIDDEN_TEMPLATE_VARIABLE' ? 403 : 409,
				);
			}
			throw error;
		}
	}

	private async present(
		schedule: StoredAutomationSchedule,
	): Promise<AutomationSchedule> {
		let targetName = schedule.targetKey;
		let targetAvailable = false;
		if (schedule.targetKind === 'agent') {
			const agent = (await this.runs.listAgents(schedule.tenantId)).find(
				(candidate) => candidate.id === schedule.targetKey,
			);
			if (agent) {
				targetName = agent.name;
				targetAvailable = agent.status === 'active';
			}
		} else {
			const adapter = this.targets.get(schedule.targetKind);
			if (adapter?.available()) {
				try {
					const reference = (
						await adapter.list({
							tenantId: schedule.tenantId,
							actor: schedule.configuredBy,
							permissionSnapshot: schedule.permissionSnapshot,
						})
					).find((target) => target.key === schedule.targetKey);
					if (reference) {
						targetName = reference.label;
						targetAvailable = true;
					}
				} catch {
					/* A revoked permission makes the target visibly unavailable. */
				}
			}
		}
		return {
			id: schedule.id,
			tenantId: schedule.tenantId,
			targetKind: schedule.targetKind,
			targetKey: schedule.targetKey,
			targetName,
			targetAvailable,
			agentId: schedule.agentId,
			agentName: targetName,
			label: schedule.label,
			inputTemplate: schedule.inputTemplate,
			cadence: schedule.cadence,
			enabled: schedule.enabled,
			disabledReason: schedule.disabledReason,
			nextRunAt: schedule.nextRunAt,
			lastRunAt: schedule.lastRunAt,
			lastRunId: schedule.lastRunId,
			lastError: schedule.lastError,
			createdAt: schedule.createdAt,
			updatedAt: schedule.updatedAt,
			createdBy: schedule.createdBy,
		};
	}

	private async audit(
		schedule: Pick<AutomationSchedule, 'tenantId' | 'id'>,
		actorId: string,
		action: string,
		occurredAt: number,
		metadata: Readonly<Record<string, string | number | boolean>>,
	): Promise<void> {
		await this.repository.appendAuditEvent({
			tenantId: schedule.tenantId,
			actorId,
			action,
			subjectType: 'automation-schedule',
			subjectId: schedule.id,
			metadata,
			occurredAt,
		});
	}
}
