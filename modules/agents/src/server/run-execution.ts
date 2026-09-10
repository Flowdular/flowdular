import {
	actorsEqual,
	normalizeActor,
	type Actor,
	type UserActor,
} from '@flowdular/kernel';
import type {
	AgentExecutionEvent,
	AgentOutputContract,
	AgentUsage,
	JsonValue,
} from '@flowdular/harness';
import type { AgentToolAccessAuthorizer } from '@flowdular/harness';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type { AgentRunStatus } from '../domain/types.ts';
import {
	AgentServiceError,
	type AgentService,
} from '../services/agent-service.ts';

export const AGENT_RUN_EXECUTION_CAPABILITY = 'agents.run-execution.v2';

export interface AgentRevisionReference {
	readonly agentId: string;
	readonly revision: number;
	readonly name: string;
	readonly status: 'active' | 'paused' | 'archived';
	readonly supportsStructuredOutput: boolean;
	readonly allowedTools: readonly string[];
}

export interface AgentChildCapabilityContext {
	readonly tenantId: string;
	readonly workflowRunId: string;
	readonly actor: Actor;
	readonly authorizationSubject?: UserActor;
	readonly permissionSnapshot: readonly string[];
}

export interface AgentRunResult {
	readonly runId: string;
	readonly status: AgentRunStatus;
	readonly output: string | null;
	readonly structuredOutput: JsonValue | null;
	readonly usage: AgentUsage | null;
	readonly failureCode: string | null;
	readonly completedAt: number | null;
}

export interface AgentRevisionExecutionCapability {
	listRevisions(
		context: AgentChildCapabilityContext,
	): Promise<readonly AgentRevisionReference[]>;
	getRevision(
		agentId: string,
		revision: number,
		context: AgentChildCapabilityContext,
	): Promise<AgentRevisionReference | null>;
	enqueueRevision(
		request: {
			readonly agentId: string;
			readonly revision: number;
			readonly input: string;
			readonly toolGrants: readonly string[];
			readonly outputContract: AgentOutputContract;
			readonly idempotencyKey: string;
		},
		context: AgentChildCapabilityContext,
	): Promise<{ readonly runId: string; readonly created: boolean }>;
	readEvents(
		runId: string,
		afterSequence: number,
		context: AgentChildCapabilityContext,
	): Promise<readonly AgentExecutionEvent[]>;
	getResult(
		runId: string,
		context: AgentChildCapabilityContext,
	): Promise<AgentRunResult | null>;
	requestCancel(
		runId: string,
		context: AgentChildCapabilityContext,
	): Promise<boolean>;
}

function requirePermission(
	context: AgentChildCapabilityContext,
	permission: string,
): void {
	if (
		context.tenantId.trim().length === 0 ||
		context.tenantId.trim().length > 128 ||
		context.workflowRunId.trim().length === 0 ||
		context.workflowRunId.trim().length > 128 ||
		!normalizeActor(context.actor)
	) {
		throw new AgentServiceError(
			'AGENT_CAPABILITY_INVALID_CONTEXT',
			'The workflow child context is invalid.',
			400,
		);
	}
	if (!context.permissionSnapshot.includes(permission)) {
		throw new AgentServiceError(
			'AGENT_CAPABILITY_FORBIDDEN',
			'The workflow actor lacks permission for this agent operation.',
			403,
		);
	}
}

function authorizationSubject(context: AgentChildCapabilityContext): UserActor {
	const actor = normalizeActor(context.actor);
	const supplied = context.authorizationSubject
		? normalizeActor(context.authorizationSubject)
		: undefined;
	const derived =
		actor?.kind === 'user'
			? actor
			: actor?.kind === 'service'
				? actor.configuredBy
				: undefined;
	const subject = supplied ?? derived;
	if (
		!subject ||
		subject.kind !== 'user' ||
		(derived !== undefined && subject.id !== derived.id)
	) {
		throw new AgentServiceError(
			'AGENT_CAPABILITY_INVALID_DELEGATION',
			'The workflow child requires a trusted delegated user.',
			403,
		);
	}
	return subject;
}

export function createAgentRevisionExecutionCapability(
	service: AgentService | (() => AgentService | Promise<AgentService>),
	authorizeToolAccess?: AgentToolAccessAuthorizer,
): AgentRevisionExecutionCapability {
	const current = async () =>
		typeof service === 'function' ? service() : service;
	return {
		async listRevisions(context) {
			requirePermission(context, AGENT_PERMISSIONS.definitionsRead);
			return (await current()).listRevisionReferences(context.tenantId);
		},
		async getRevision(agentId, revision, context) {
			requirePermission(context, AGENT_PERMISSIONS.definitionsRead);
			return (await current()).getRevisionReference(
				context.tenantId,
				agentId,
				revision,
			);
		},
		async enqueueRevision(request, context) {
			requirePermission(context, AGENT_PERMISSIONS.runsExecute);
			const subject = authorizationSubject(context);
			if (authorizeToolAccess) {
				const live = new Set(
					await authorizeToolAccess({
						tenantId: context.tenantId,
						actor: subject,
						signal: new AbortController().signal,
					}),
				);
				if (!live.has(AGENT_PERMISSIONS.runsExecute)) {
					throw new AgentServiceError(
						'AGENT_CAPABILITY_PERMISSION_REVOKED',
						'The delegated user no longer has permission to execute agents.',
						403,
					);
				}
			}
			return (await current()).enqueueRevisionRun(
				{ ...context, authorizationSubject: subject },
				request,
			);
		},
		async readEvents(runId, afterSequence, context) {
			requirePermission(context, AGENT_PERMISSIONS.runsRead);
			const service = await current();
			const actor = normalizeActor(context.actor);
			const run = await service.getWorkflowRun(
				context.tenantId,
				context.workflowRunId,
				runId,
			);
			if (!actor || !run || !actorsEqual(run.requestedActor, actor)) return [];
			return await service.readWorkflowRunEvents(
				context.tenantId,
				context.workflowRunId,
				runId,
				afterSequence,
			);
		},
		async getResult(runId, context) {
			requirePermission(context, AGENT_PERMISSIONS.runsRead);
			const actor = normalizeActor(context.actor);
			const run = await (
				await current()
			).getWorkflowRun(context.tenantId, context.workflowRunId, runId);
			if (!actor || !run || !actorsEqual(run.requestedActor, actor))
				return null;
			return run
				? {
						runId: run.id,
						status: run.status,
						output: run.output,
						structuredOutput: run.structuredOutput,
						usage: run.usage,
						failureCode: run.failureCode,
						completedAt: run.completedAt,
					}
				: null;
		},
		async requestCancel(runId, context) {
			requirePermission(context, AGENT_PERMISSIONS.runsExecute);
			const service = await current();
			const actor = normalizeActor(context.actor);
			const run = await service.getWorkflowRun(
				context.tenantId,
				context.workflowRunId,
				runId,
			);
			if (!actor || !run || !actorsEqual(run.requestedActor, actor))
				return false;
			return await service.cancelWorkflowRun(context, runId);
		},
	};
}
