import {
	serviceActor,
	type PlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	AUTOMATION_TARGETS_CAPABILITY,
	type AutomationTargetAdapter,
	type AutomationTargetAuthorizationContext,
	type AutomationTargetInvocationContext,
	type AutomationTargetRegistry,
} from '@flowdular/module-automations/server';
import { WORKFLOWS_PERMISSIONS } from '@flowdular/module-workflows';
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from '@flowdular/module-workflows/server';

type WorkflowInput = Parameters<
	WorkflowExecutionCapability['enqueue']
>[0]['input'];

export class WorkflowAutomationTargetError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'WorkflowAutomationTargetError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (
		normalized.length < min ||
		normalized.length > max ||
		normalized.includes('\u0000')
	) {
		throw new WorkflowAutomationTargetError(
			'AUTOMATION_TARGET_INPUT_INVALID',
			`${field} is invalid.`,
		);
	}
	return normalized;
}

function workflowsOrRefusal(
	resolve: () => WorkflowExecutionCapability | null,
): WorkflowExecutionCapability {
	const workflows = resolve();
	if (!workflows) {
		throw new WorkflowAutomationTargetError(
			'AUTOMATION_TARGET_UNAVAILABLE',
			'Workflow execution is unavailable.',
			503,
		);
	}
	return workflows;
}

function workflowContext(context: AutomationTargetAuthorizationContext) {
	return {
		tenantId: bounded(context.tenantId, 'tenantId', 1, 128),
		actor: context.actor,
		authorizationSubject: context.actor,
		permissionSnapshot: [...new Set(context.permissionSnapshot)].sort(),
	};
}

async function requireExecutable(
	resolve: () => WorkflowExecutionCapability | null,
	workflowKey: string,
	context: AutomationTargetAuthorizationContext,
) {
	const permissions = new Set(context.permissionSnapshot);
	for (const permission of [
		WORKFLOWS_PERMISSIONS.read,
		WORKFLOWS_PERMISSIONS.runsExecute,
	]) {
		if (!permissions.has(permission)) {
			throw new WorkflowAutomationTargetError(
				'WORKFLOW_PERMISSION_DENIED',
				'The workflow target requires workflow read and execute permissions.',
				403,
			);
		}
	}
	const reference = await workflowsOrRefusal(resolve).getPublishedReference(
		bounded(workflowKey, 'workflowKey', 3, 120),
		workflowContext(context),
	);
	if (!reference) {
		throw new WorkflowAutomationTargetError(
			'WORKFLOW_NOT_FOUND',
			'The published workflow target was not found.',
			404,
		);
	}
	for (const permission of reference.requiredPermissions) {
		if (!permissions.has(permission)) {
			throw new WorkflowAutomationTargetError(
				'WORKFLOW_PERMISSION_DENIED',
				'The workflow target requires permissions the configuring user does not hold.',
				403,
			);
		}
	}
	return reference;
}

function idempotencyKey(context: AutomationTargetInvocationContext): string {
	const source = context.source;
	if (source.kind === 'schedule') {
		if (!Number.isSafeInteger(source.slot) || source.slot < 0) {
			throw new WorkflowAutomationTargetError(
				'AUTOMATION_TARGET_INPUT_INVALID',
				'Schedule slot is invalid.',
			);
		}
		return `automations-workflows:schedule:${bounded(
			source.scheduleId,
			'scheduleId',
			1,
			128,
		)}:${source.slot}`;
	}
	if (source.kind === 'webhook') {
		const digest = bounded(
			source.acceptedSignatureDigest,
			'acceptedSignatureDigest',
			64,
			64,
		);
		if (!/^[a-f0-9]{64}$/.test(digest)) {
			throw new WorkflowAutomationTargetError(
				'AUTOMATION_TARGET_INPUT_INVALID',
				'Accepted signature digest is invalid.',
			);
		}
		return `automations-workflows:webhook:${bounded(
			source.triggerId,
			'triggerId',
			1,
			128,
		)}:${digest}`;
	}
	return `automations-workflows:run-now:${bounded(
		source.scheduleId,
		'scheduleId',
		1,
		128,
	)}:${bounded(source.requestId, 'requestId', 8, 80)}`;
}

export function createWorkflowAutomationTargetAdapter(
	resolveWorkflows: () => WorkflowExecutionCapability | null,
): AutomationTargetAdapter {
	return {
		kind: 'workflow',
		contractVersion: 1,
		available: () => resolveWorkflows() !== null,
		async list(context) {
			const published = await workflowsOrRefusal(
				resolveWorkflows,
			).listPublished(workflowContext(context));
			const entries = [];
			for (const workflow of published) {
				try {
					const executable = await requireExecutable(
						resolveWorkflows,
						workflow.key,
						context,
					);
					entries.push({
						key: executable.key,
						label: executable.name,
						revision: executable.revision,
					});
				} catch {
					/* A workflow the configuring user may not execute is simply not
					   offered as a target. */
				}
			}
			return entries;
		},
		async validate(targetKey, context) {
			const workflow = await requireExecutable(
				resolveWorkflows,
				targetKey,
				context,
			);
			return {
				key: workflow.key,
				label: workflow.name,
				revision: workflow.revision,
			};
		},
		async invoke(request, context) {
			const reference = await requireExecutable(
				resolveWorkflows,
				request.targetKey,
				{
					tenantId: context.tenantId,
					actor: context.configuredBy,
					permissionSnapshot: context.permissionSnapshot,
				},
			);
			const source = context.source;
			const actor =
				source.kind === 'run-now'
					? source.actor
					: serviceActor({
							serviceId: 'automations.core',
							label: 'Automations',
							configuredBy: context.configuredBy,
						});
			const origin =
				source.kind === 'run-now'
					? {
							kind: 'module' as const,
							moduleId: 'automations.core',
							operationId: 'schedules.run-now',
						}
					: source.kind === 'schedule'
						? { kind: 'schedule' as const, scheduleId: source.scheduleId }
						: { kind: 'webhook' as const, triggerId: source.triggerId };
			const accepted = await workflowsOrRefusal(resolveWorkflows).enqueue(
				{
					workflowKey: reference.key,
					input: request.input as WorkflowInput,
					idempotencyKey: idempotencyKey(context),
				},
				{
					tenantId: bounded(context.tenantId, 'tenantId', 1, 128),
					actor,
					authorizationSubject:
						source.kind === 'run-now' ? source.actor : context.configuredBy,
					origin,
					permissionSnapshot: [...new Set(context.permissionSnapshot)].sort(),
				},
			);
			return {
				correlationId: accepted.runId,
				created: accepted.created,
				status: accepted.status,
			};
		},
	};
}

export function registerAutomationsWorkflowsIntegration(
	capabilities: PlatformCapabilityRegistry,
): boolean {
	const targets = capabilities.get<AutomationTargetRegistry>(
		AUTOMATION_TARGETS_CAPABILITY,
	);
	if (!targets) return false;
	targets.register(
		createWorkflowAutomationTargetAdapter(() =>
			capabilities.get<WorkflowExecutionCapability>(
				WORKFLOW_EXECUTION_CAPABILITY,
			),
		),
	);
	return true;
}
