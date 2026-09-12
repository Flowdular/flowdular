import { createHash } from 'node:crypto';
import type { AgentTool, AgentToolContext } from '@flowdular/harness/runtime';
import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import type { AutomationExecutionCapability } from './execution.ts';

export const AUTOMATION_SCHEDULE_ACTION_ID =
	'automations-workflows.schedule.run';

/* A workflow may dispatch an agent target only. A workflow target here would
   let a workflow fire an automation that starts that same workflow again. */
export const WORKFLOW_DISPATCHABLE_TARGET_KINDS = Object.freeze(['agent']);

export class WorkflowAutomationActionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'WorkflowAutomationActionError';
	}
}

function scheduleId(input: unknown): string {
	const value = (input ?? {}) as Record<string, unknown>;
	const id =
		typeof value.scheduleId === 'string' ? value.scheduleId.trim() : '';
	if (id.length < 1 || id.length > 128 || id.includes('\u0000')) {
		throw new WorkflowAutomationActionError(
			'AUTOMATION_ACTION_INPUT_INVALID',
			'scheduleId is invalid.',
		);
	}
	return id;
}

/* The node key is `<tenant>:<run>:<node>`, which has no length the automations
   ledger accepts. The digest keeps one node bound to one automation run inside
   the 128 character key limit. */
function automationRunKey(nodeIdempotencyKey: string): string {
	return `automations-workflows:action:${createHash('sha256')
		.update(nodeIdempotencyKey)
		.digest('hex')}`;
}

async function runAutomationSchedule(
	resolveAutomations: () => AutomationExecutionCapability | null,
	input: unknown,
	context: AgentToolContext,
) {
	const id = scheduleId(input);
	const actor = context.actor;
	/* How the tool was reached decides, not who the actor is: a model turn firing
	   an automation would close the loop agent, automation, agent, while a
	   workflow node keeps its own run actor, which may itself be an agent. An
	   absent kind is an agent run, because the workflow action runtime always
	   states it. The actor stays identity for the run it dispatches. */
	if (context.invocation !== 'workflow-action' || !actor) {
		throw new WorkflowAutomationActionError(
			'AUTOMATION_ACTION_ACTOR_DENIED',
			'Only a workflow action call with a run actor can run an automation schedule.',
			403,
		);
	}
	if (!context.permissions.has(AUTOMATIONS_PERMISSIONS.manage)) {
		throw new WorkflowAutomationActionError(
			'AUTOMATION_PERMISSION_DENIED',
			`Running an automation schedule requires ${AUTOMATIONS_PERMISSIONS.manage}.`,
			403,
		);
	}
	if (!context.idempotencyKey) {
		throw new WorkflowAutomationActionError(
			'AUTOMATION_IDEMPOTENCY_KEY_REQUIRED',
			'An automation schedule run requires a durable idempotency key.',
			409,
		);
	}
	const automations = resolveAutomations();
	if (!automations) {
		throw new WorkflowAutomationActionError(
			'AUTOMATION_EXECUTION_UNAVAILABLE',
			'Automation execution is unavailable.',
			503,
		);
	}
	const accepted = await automations.runScheduleNow(
		{
			scheduleId: id,
			idempotencyKey: automationRunKey(context.idempotencyKey),
			allowedTargetKinds: WORKFLOW_DISPATCHABLE_TARGET_KINDS,
		},
		{
			tenantId: context.tenantId,
			actor,
			permissionSnapshot: [...context.permissions],
		},
	);
	return {
		scheduleId: id,
		correlationId: accepted.correlationId,
		created: accepted.created,
		targetKind: accepted.targetKind,
	};
}

export function createAutomationWorkflowActionTools(
	resolveAutomations: () => AutomationExecutionCapability | null,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: AUTOMATION_SCHEDULE_ACTION_ID,
			endpointId: 'automations.schedules.run',
			description:
				'Run an automation schedule now and return its agent run correlation.',
			requiredPermissions: [AUTOMATIONS_PERMISSIONS.manage],
			contractVersion: 1,
			risk: 'workspace-write',
			idempotency: 'required',
			/* The agents run ledger binds the key to the request and returns the
			   first run, so a repeated node attempt cannot fire twice. */
			idempotencyProtection: 'target-ledger',
			cancellation: 'not-supported',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['scheduleId'],
				properties: { scheduleId: { type: 'string' } },
			},
			outputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['scheduleId', 'correlationId', 'created', 'targetKind'],
				properties: {
					scheduleId: { type: 'string' },
					correlationId: { type: 'string' },
					created: { type: 'boolean' },
					targetKind: { type: 'string' },
				},
			},
			execute: (input, context) =>
				runAutomationSchedule(resolveAutomations, input, context),
		}),
	];
}
