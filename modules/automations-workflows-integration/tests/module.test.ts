import { createPlatformCapabilityRegistry, userActor } from '@coreloom/kernel';
import {
	AUTOMATION_TARGETS_CAPABILITY,
	createAutomationTargetRegistry,
	type AutomationTargetRegistry,
} from '@coreloom/module-automations/server';
import { WORKFLOWS_PERMISSIONS } from '@coreloom/module-workflows';
import {
	WORKFLOW_EXECUTION_CAPABILITY,
	type WorkflowExecutionCapability,
} from '@coreloom/module-workflows/server';
import { describe, expect, it, vi } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import {
	createWorkflowAutomationTargetAdapter,
	registerAutomationsWorkflowsIntegration,
} from '../src/server/adapter.ts';

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
		listPublished: (context) =>
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
		getPublishedReference: (workflowKey, context) =>
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
		getRun: () => null,
		cancel: (runId) => ({ runId, status: 'cancelled', requested: false }),
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

describe('automations-workflows.integration', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe(
			'automations-workflows.integration',
		);
	});

	it('registers exactly one workflow adapter and refuses duplicate composition', () => {
		const capabilities = createPlatformCapabilityRegistry();
		const targets = createAutomationTargetRegistry();
		capabilities.register(AUTOMATION_TARGETS_CAPABILITY, targets);
		const { capability } = workflowCapability();
		capabilities.register(WORKFLOW_EXECUTION_CAPABILITY, capability);

		expect(registerAutomationsWorkflowsIntegration(capabilities)).toBe(true);
		expect(targets.get('workflow')?.available()).toBe(true);
		expect(() => registerAutomationsWorkflowsIntegration(capabilities)).toThrow(
			/already registered/,
		);
	});

	it('stays optional when either public capability is absent', () => {
		const capabilities = createPlatformCapabilityRegistry();
		expect(registerAutomationsWorkflowsIntegration(capabilities)).toBe(false);

		const targets = createAutomationTargetRegistry();
		capabilities.register(AUTOMATION_TARGETS_CAPABILITY, targets);
		expect(registerAutomationsWorkflowsIntegration(capabilities)).toBe(true);
		const adapter = targets.get('workflow')!;
		expect(adapter.available()).toBe(false);
		expect(() => adapter.list(context())).toThrowError(
			expect.objectContaining({ code: 'AUTOMATION_TARGET_UNAVAILABLE' }),
		);
	});

	it('lists only the trusted tenant and validates the complete permission ceiling', () => {
		const { capability } = workflowCapability();
		const adapter = createWorkflowAutomationTargetAdapter(() => capability);
		expect(adapter.list(context())).toEqual([
			{ key: 'review-party', label: 'Review party', revision: 4 },
		]);
		expect(adapter.list({ ...context(), tenantId: 'tenant-b' })).toEqual([]);
		expect(adapter.validate('review-party', context())).toEqual({
			key: 'review-party',
			label: 'Review party',
			revision: 4,
		});
		expect(() =>
			adapter.validate('review-party', {
				...context(),
				permissionSnapshot: [WORKFLOWS_PERMISSIONS.read],
			}),
		).toThrowError(
			expect.objectContaining({ code: 'WORKFLOW_PERMISSION_DENIED' }),
		);
		expect(() =>
			createWorkflowAutomationTargetAdapter(
				() => workflowCapability(['catalog.items.read']).capability,
			).validate('review-party', context()),
		).toThrowError(
			expect.objectContaining({ code: 'WORKFLOW_PERMISSION_DENIED' }),
		);
	});

	it('invokes a schedule as the automations service with stable slot idempotency', async () => {
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

	it('keeps Run now attributed to the requesting user', async () => {
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

	it('passes verified webhook input unchanged and keys it by the accepted digest', async () => {
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

	it('passes workflow refusals through without selecting another target', async () => {
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
