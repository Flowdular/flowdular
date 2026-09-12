import type { AgentTool, AgentToolContext } from '@flowdular/harness/runtime';
import {
	agentActor,
	createPlatformCapabilityRegistry,
	userActor,
} from '@flowdular/kernel';
import { WORKFLOWS_PERMISSIONS } from '@flowdular/module-workflows';
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from '@flowdular/module-workflows/server';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationExecutionCapability } from '../src/server/execution.ts';
import {
	createAutomationTargetRegistry,
	type AutomationTargetRegistry,
} from '../src/server/targets.ts';
import {
	createWorkflowAutomationTargetAdapter,
	registerWorkflowAutomationTarget,
} from '../src/server/workflow-target.ts';
import {
	AUTOMATION_SCHEDULE_ACTION_ID,
	createAutomationWorkflowActionTools,
	WORKFLOW_DISPATCHABLE_TARGET_KINDS,
} from '../src/server/workflow-tools.ts';

const configuringUser = userActor({
	accountId: 'owner-1',
	displayName: 'Ada Owner',
	email: 'ada@example.com',
});
const requestingUser = userActor({
	accountId: 'operator-2',
	displayName: 'Ola Operator',
	email: 'ola@example.com',
});
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.runsExecute,
	'parties.records.read',
] as const;

function workflowCapability(requiredPermissions = ['parties.records.read']) {
	const enqueue = vi.fn<WorkflowExecutionCapability['enqueue']>(
		async (_request, _context) => ({
			runId: 'workflow-run-1',
			workflowId: 'workflow-1',
			workflowRevision: 4,
			status: 'queued',
			created: true,
		}),
	);
	const capability: WorkflowExecutionCapability = {
		listPublished: async (context) =>
			context.tenantId === 'tenant-a'
				? [
						{
							id: 'workflow-1',
							key: 'review-party',
							name: 'Review party',
							revision: 4,
							graphChecksum: 'graph-checksum',
						},
					]
				: [],
		getPublishedReference: async (workflowKey, context) =>
			context.tenantId === 'tenant-a' && workflowKey === 'review-party'
				? {
						id: 'workflow-1',
						key: 'review-party',
						name: 'Review party',
						revision: 4,
						graphChecksum: 'graph-checksum',
						requiredPermissions,
					}
				: null,
		enqueue,
		getRun: async () => null,
		cancel: async (runId) => ({ runId, status: 'cancelled', requested: false }),
	};
	return { capability, enqueue };
}

function context() {
	return {
		tenantId: 'tenant-a',
		actor: configuringUser,
		permissionSnapshot: permissions,
	};
}

describe('workflow automation target adapter', () => {
	it('AUTO-WORKFLOW-REGISTER registers exactly one workflow adapter and refuses a duplicate', async () => {
		const capabilities = createPlatformCapabilityRegistry();
		const targets = createAutomationTargetRegistry();
		const { capability } = workflowCapability();
		capabilities.register(WORKFLOW_EXECUTION_CAPABILITY, capability);

		registerWorkflowAutomationTarget(targets, capabilities);
		expect(targets.get('workflow')?.available()).toBe(true);
		expect(() =>
			registerWorkflowAutomationTarget(targets, capabilities),
		).toThrow(/already registered/);
	});

	it('AUTO-WORKFLOW-OPTIONAL stays unavailable while workflows.core is not composed', async () => {
		const capabilities = createPlatformCapabilityRegistry();
		const targets = createAutomationTargetRegistry();
		registerWorkflowAutomationTarget(targets, capabilities);
		const adapter = targets.get('workflow')!;
		expect(adapter.available()).toBe(false);
		await expect(adapter.list(context())).rejects.toThrowError(
			expect.objectContaining({ code: 'AUTOMATION_TARGET_UNAVAILABLE' }),
		);

		const { capability } = workflowCapability();
		capabilities.register(WORKFLOW_EXECUTION_CAPABILITY, capability);
		expect(adapter.available()).toBe(true);
	});

	it('AUTO-WORKFLOW-TENANT AUTO-WORKFLOW-CONFIGURE-DENY lists only the trusted tenant and validates the complete permission ceiling', async () => {
		const { capability } = workflowCapability();
		const adapter = createWorkflowAutomationTargetAdapter(() => capability);
		expect(await adapter.list(context())).toEqual([
			{ key: 'review-party', label: 'Review party', revision: 4 },
		]);
		expect(await adapter.list({ ...context(), tenantId: 'tenant-b' })).toEqual(
			[],
		);
		expect(await adapter.validate('review-party', context())).toEqual({
			key: 'review-party',
			label: 'Review party',
			revision: 4,
		});
		await expect(
			adapter.validate('review-party', {
				...context(),
				permissionSnapshot: [WORKFLOWS_PERMISSIONS.read],
			}),
		).rejects.toThrowError(
			expect.objectContaining({ code: 'WORKFLOW_PERMISSION_DENIED' }),
		);
		await expect(
			createWorkflowAutomationTargetAdapter(
				() => workflowCapability(['catalog.items.read']).capability,
			).validate('review-party', context()),
		).rejects.toThrowError(
			expect.objectContaining({ code: 'WORKFLOW_PERMISSION_DENIED' }),
		);
	});

	it('AUTO-WORKFLOW-SCHEDULE invokes a schedule as the automations service with stable slot idempotency', async () => {
		const { capability, enqueue } = workflowCapability();
		const adapter = createWorkflowAutomationTargetAdapter(() => capability);
		await expect(
			adapter.invoke(
				{ targetKey: 'review-party', input: { partyId: 'party-1' } },
				{
					tenantId: 'tenant-a',
					configuredBy: configuringUser,
					permissionSnapshot: permissions,
					source: {
						kind: 'schedule',
						scheduleId: 'schedule-1',
						slot: 1_725_000,
					},
				},
			),
		).resolves.toEqual({
			correlationId: 'workflow-run-1',
			created: true,
			status: 'queued',
		});
		expect(enqueue).toHaveBeenCalledWith(
			{
				workflowKey: 'review-party',
				input: { partyId: 'party-1' },
				idempotencyKey: 'automations-workflows:schedule:schedule-1:1725000',
			},
			expect.objectContaining({
				tenantId: 'tenant-a',
				actor: {
					kind: 'service',
					id: 'automations.core',
					label: 'Automations',
					configuredBy: configuringUser,
				},
				authorizationSubject: configuringUser,
				origin: { kind: 'schedule', scheduleId: 'schedule-1' },
				permissionSnapshot: [...permissions].sort(),
			}),
		);
	});

	it('AUTO-WORKFLOW-RUN-NOW keeps Run now attributed to the requesting user', async () => {
		const { capability, enqueue } = workflowCapability();
		const adapter = createWorkflowAutomationTargetAdapter(() => capability);
		await adapter.invoke(
			{ targetKey: 'review-party', input: { approved: true } },
			{
				tenantId: 'tenant-a',
				configuredBy: configuringUser,
				permissionSnapshot: permissions,
				source: {
					kind: 'run-now',
					scheduleId: 'schedule-1',
					requestId: 'request-0001',
					actor: requestingUser,
				},
			},
		);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: 'automations-workflows:run-now:schedule-1:request-0001',
			}),
			expect.objectContaining({
				actor: requestingUser,
				authorizationSubject: requestingUser,
				origin: {
					kind: 'module',
					moduleId: 'automations.core',
					operationId: 'schedules.run-now',
				},
			}),
		);
	});

	it('AUTO-WORKFLOW-WEBHOOK passes verified webhook input unchanged and keys it by the accepted digest', async () => {
		const { capability, enqueue } = workflowCapability();
		const adapter = createWorkflowAutomationTargetAdapter(() => capability);
		const digest = 'a'.repeat(64);
		const input = { nested: { value: 2 }, accepted: true } as const;
		await adapter.invoke(
			{ targetKey: 'review-party', input },
			{
				tenantId: 'tenant-a',
				configuredBy: configuringUser,
				permissionSnapshot: permissions,
				source: {
					kind: 'webhook',
					triggerId: 'trigger-1',
					acceptedSignatureDigest: digest,
				},
			},
		);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				input,
				idempotencyKey: `automations-workflows:webhook:trigger-1:${digest}`,
			}),
			expect.objectContaining({
				origin: { kind: 'webhook', triggerId: 'trigger-1' },
			}),
		);
		await expect(
			adapter.invoke(
				{ targetKey: 'review-party', input },
				{
					tenantId: 'tenant-a',
					configuredBy: configuringUser,
					permissionSnapshot: permissions,
					source: {
						kind: 'webhook',
						triggerId: 'trigger-1',
						acceptedSignatureDigest: 'not-a-digest',
					},
				},
			),
		).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_INPUT_INVALID' });
	});

	it('AUTO-WORKFLOW-IDEMPOTENCY-CONFLICT passes workflow refusals through without selecting another target', async () => {
		const { capability, enqueue } = workflowCapability();
		const conflict = Object.assign(new Error('Idempotency conflict.'), {
			code: 'WORKFLOW_IDEMPOTENCY_CONFLICT',
		});
		enqueue.mockRejectedValueOnce(conflict);
		const targets: AutomationTargetRegistry = createAutomationTargetRegistry();
		targets.register(createWorkflowAutomationTargetAdapter(() => capability));
		await expect(
			targets.get('workflow')!.invoke(
				{ targetKey: 'review-party', input: null },
				{
					tenantId: 'tenant-a',
					configuredBy: configuringUser,
					permissionSnapshot: permissions,
					source: {
						kind: 'schedule',
						scheduleId: 'schedule-1',
						slot: 1,
					},
				},
			),
		).rejects.toBe(conflict);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});
});

describe('AUTO-WORKFLOW-ACTION workflow runs an automation schedule', () => {
	const AUTOMATIONS_MANAGE = 'automations.schedules.manage';

	function executionCapability() {
		const runScheduleNow = vi.fn<
			AutomationExecutionCapability['runScheduleNow']
		>(async (_request, _context) => ({
			correlationId: 'agent-run-9',
			created: true,
			targetKind: 'agent',
		}));
		return { runScheduleNow } satisfies AutomationExecutionCapability;
	}

	function toolContext(
		overrides: Partial<AgentToolContext> = {},
	): AgentToolContext {
		return {
			runId: 'workflow-run-1',
			tenantId: 'tenant-a',
			requestedBy: 'operator-2',
			idempotencyKey: 'tenant-a:workflow-run-1:node-3',
			actor: requestingUser,
			permissions: new Set([AUTOMATIONS_MANAGE]),
			signal: new AbortController().signal,
			...overrides,
		};
	}

	function tool(capability: AutomationExecutionCapability | null): AgentTool {
		const tools = createAutomationWorkflowActionTools(() => capability);
		const found = tools.find(
			(entry) => entry.id === AUTOMATION_SCHEDULE_ACTION_ID,
		);
		expect(found, AUTOMATION_SCHEDULE_ACTION_ID).toBeDefined();
		return found!;
	}

	it('dispatches an agent target only, so a schedule cannot re-enter the workflow', async () => {
		const capability = executionCapability();
		await tool(capability).execute({ scheduleId: 'schedule-1' }, toolContext());
		const [request] = capability.runScheduleNow.mock.calls[0]!;
		expect(request.allowedTargetKinds).toEqual(['agent']);
		expect([...WORKFLOW_DISPATCHABLE_TARGET_KINDS]).toEqual(['agent']);
	});

	it('refuses a caller without the automations manage permission', async () => {
		const capability = executionCapability();
		await expect(
			tool(capability).execute(
				{ scheduleId: 'schedule-1' },
				toolContext({ permissions: new Set(['automations.schedules.read']) }),
			),
		).rejects.toMatchObject({
			code: 'AUTOMATION_PERMISSION_DENIED',
			status: 403,
		});
		expect(capability.runScheduleNow).not.toHaveBeenCalled();
	});

	it('refuses an agent actor, so an agent cannot loop back through an automation', async () => {
		const capability = executionCapability();
		await expect(
			tool(capability).execute(
				{ scheduleId: 'schedule-1' },
				toolContext({
					actor: agentActor({
						agentId: 'agent-1',
						agentName: 'Reviewer',
						runId: 'agent-run-1',
					}),
				}),
			),
		).rejects.toMatchObject({
			code: 'AUTOMATION_ACTION_ACTOR_DENIED',
			status: 403,
		});
		expect(capability.runScheduleNow).not.toHaveBeenCalled();
	});

	it('refuses without a durable idempotency key', async () => {
		const capability = executionCapability();
		const { idempotencyKey: _unused, ...withoutKey } = toolContext();
		await expect(
			tool(capability).execute({ scheduleId: 'schedule-1' }, withoutKey),
		).rejects.toMatchObject({
			code: 'AUTOMATION_IDEMPOTENCY_KEY_REQUIRED',
			status: 409,
		});
		expect(capability.runScheduleNow).not.toHaveBeenCalled();
	});

	it('refuses when automation execution is not composed', async () => {
		await expect(
			tool(null).execute({ scheduleId: 'schedule-1' }, toolContext()),
		).rejects.toMatchObject({
			code: 'AUTOMATION_EXECUTION_UNAVAILABLE',
			status: 503,
		});
	});

	it('derives one automation key per node, so a retried attempt fires once', async () => {
		const capability = executionCapability();
		const target = tool(capability);
		await target.execute({ scheduleId: 'schedule-1' }, toolContext());
		await target.execute({ scheduleId: 'schedule-1' }, toolContext());
		await target.execute(
			{ scheduleId: 'schedule-1' },
			toolContext({ idempotencyKey: 'tenant-a:workflow-run-1:node-4' }),
		);
		const keys = capability.runScheduleNow.mock.calls.map(
			([request]) => request.idempotencyKey,
		);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[2]).not.toBe(keys[0]);
		for (const key of keys) expect(key.length).toBeLessThanOrEqual(128);
	});

	it('rejects an invalid schedule id before reaching automations', async () => {
		const capability = executionCapability();
		await expect(
			tool(capability).execute({ scheduleId: '  ' }, toolContext()),
		).rejects.toMatchObject({ code: 'AUTOMATION_ACTION_INPUT_INVALID' });
		expect(capability.runScheduleNow).not.toHaveBeenCalled();
	});
});
