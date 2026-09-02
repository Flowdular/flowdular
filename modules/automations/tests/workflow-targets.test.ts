import { userActor } from '@coreloom/kernel';
import type { AgentRunQueue } from '@coreloom/module-agents/server';
import { describe, expect, it, vi } from 'vitest';
import { AUTOMATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	automationTargetOptions,
	automationTargetValue,
	parseAutomationTargetValue,
} from '../src/client/target-selection.ts';
import {
	createAutomationTargetRegistry,
	type AutomationTargetAdapter,
	type AutomationTargetInvocationContext,
	type AutomationTargetInvocationRequest,
} from '../src/server/targets.ts';
import { AutomationScheduleService } from '../src/services/schedule-service.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import { SqliteAutomationsRepository } from '../src/services/sqlite-repository.ts';
import {
	AutomationTriggerService,
	triggerSignature,
	triggerSignedPayload,
} from '../src/services/trigger-service.ts';

const configuringUser = userActor({
	accountId: 'owner-1',
	displayName: 'Ada Owner',
	email: 'ada@example.com',
});
const scopes = [
	AUTOMATIONS_PERMISSIONS.manage,
	'workflows.definitions.read',
	'workflows.runs.execute',
	'parties.records.read',
] as const;

function noAgentQueue(): AgentRunQueue {
	return {
		listAgents: () => [],
		enqueue: async () => {
			throw new Error('The workflow path must not enqueue an agent.');
		},
		enqueueWithOutcome: async () => {
			throw new Error('The workflow path must not enqueue an agent.');
		},
	};
}

function targetFixture() {
	const invocations: Array<{
		readonly request: AutomationTargetInvocationRequest;
		readonly context: AutomationTargetInvocationContext;
	}> = [];
	const accepted = new Map<string, string>();
	const validate = vi.fn<AutomationTargetAdapter['validate']>(
		(targetKey, context) => {
			if (context.tenantId !== 'tenant-a' || targetKey !== 'party-review') {
				throw Object.assign(new Error('Workflow not found.'), {
					code: 'WORKFLOW_NOT_FOUND',
					status: 404,
				});
			}
			if (!context.permissionSnapshot.includes('parties.records.read')) {
				throw Object.assign(new Error('Workflow permission denied.'), {
					code: 'WORKFLOW_PERMISSION_DENIED',
					status: 403,
				});
			}
			return { key: targetKey, label: 'Party review', revision: 3 };
		},
	);
	const adapter: AutomationTargetAdapter = {
		kind: 'workflow',
		contractVersion: 1,
		available: () => true,
		list: (context) =>
			context.tenantId === 'tenant-a' &&
			context.permissionSnapshot.includes('parties.records.read')
				? [{ key: 'party-review', label: 'Party review', revision: 3 }]
				: [],
		validate,
		invoke: async (request, context) => {
			invocations.push({ request, context });
			const key = JSON.stringify([request, context.tenantId, context.source]);
			const existing = accepted.get(key);
			const correlationId = existing ?? `workflow-run-${accepted.size + 1}`;
			if (!existing) accepted.set(key, correlationId);
			return {
				correlationId,
				created: existing === undefined,
				status: 'queued',
			};
		},
	};
	const registry = createAutomationTargetRegistry();
	registry.register(adapter);
	return { registry, validate, invocations };
}

describe('workflow automation targets', () => {
	it('round-trips target values and retains an unavailable saved target', () => {
		const encoded = automationTargetValue({
			kind: 'workflow',
			key: 'party:review/v2',
		});
		expect(parseAutomationTargetValue(encoded)).toEqual({
			kind: 'workflow',
			key: 'party:review/v2',
		});
		expect(
			automationTargetOptions([], {
				kind: 'workflow',
				key: 'archived-review',
				label: 'archived-review',
			}),
		).toEqual([
			expect.objectContaining({
				kind: 'workflow',
				key: 'archived-review',
				available: false,
			}),
		]);
	});

	it('stores trusted workflow configuration and refuses missing permissions before persistence', () => {
		const repository = new SqliteAutomationsRepository(':memory:');
		const target = targetFixture();
		const service = new AutomationScheduleService(
			repository,
			noAgentQueue(),
			() => 1_000,
			new AbortController().signal,
			undefined,
			target.registry,
		);
		const created = service.create(
			'tenant-a',
			configuringUser,
			{
				targetKind: 'workflow',
				targetKey: 'party-review',
				label: 'Review new parties',
				inputTemplate: '{"partyId":"party-1"}',
				cadence: 'every:60',
				enabled: true,
			},
			scopes,
		);

		expect(created).toMatchObject({
			targetKind: 'workflow',
			targetKey: 'party-review',
			targetName: 'Party review',
			targetAvailable: true,
			agentId: '',
		});
		expect(repository.getSchedule('tenant-a', created.id)).toMatchObject({
			configuredBy: configuringUser,
			permissionSnapshot: [...scopes].sort(),
		});
		expect(() =>
			service.create(
				'tenant-a',
				configuringUser,
				{
					targetKind: 'workflow',
					targetKey: 'party-review',
					label: 'Unauthorized target',
					inputTemplate: '{}',
					cadence: 'every:60',
					enabled: true,
				},
				[AUTOMATIONS_PERMISSIONS.manage],
			),
		).toThrowError(
			expect.objectContaining({ code: 'WORKFLOW_PERMISSION_DENIED' }),
		);
		expect(repository.listSchedules('tenant-a')).toHaveLength(1);
	});

	it('dispatches automatic and manual schedule runs without target fallback', async () => {
		let now = 10_000;
		const repository = new SqliteAutomationsRepository(':memory:');
		const target = targetFixture();
		const service = new AutomationScheduleService(
			repository,
			noAgentQueue(),
			() => now,
			new AbortController().signal,
			undefined,
			target.registry,
		);
		const created = service.create(
			'tenant-a',
			configuringUser,
			{
				targetKind: 'workflow',
				targetKey: 'party-review',
				label: 'Party review',
				inputTemplate: '{"partyId":"party-1"}',
				cadence: 'every:1',
				enabled: true,
			},
			scopes,
		);
		now += 60_000;
		expect(await service.tick()).toBe(1);
		expect(target.invocations[0]).toEqual({
			request: {
				targetKey: 'party-review',
				input: { partyId: 'party-1' },
			},
			context: {
				tenantId: 'tenant-a',
				configuredBy: configuringUser,
				permissionSnapshot: [...scopes].sort(),
				source: {
					kind: 'schedule',
					scheduleId: created.id,
					slot: 70_000,
				},
			},
		});

		const operator = userActor({
			accountId: 'operator-2',
			email: 'operator@example.com',
		});
		const currentScopes = [...scopes, 'catalog.items.read'];
		await service.runNow('tenant-a', operator, created.id, currentScopes);
		expect(target.invocations[1]?.context).toMatchObject({
			configuredBy: operator,
			permissionSnapshot: [...currentScopes].sort(),
			source: {
				kind: 'run-now',
				scheduleId: created.id,
				actor: operator,
			},
		});
	});

	it('passes a verified webhook JSON body with a stable accepted signature digest', async () => {
		const now = 1_800_000;
		const repository = new SqliteAutomationsRepository(':memory:');
		const target = targetFixture();
		const service = new AutomationTriggerService(
			repository,
			new AesGcmSecretVault(Buffer.alloc(32, 6)),
			noAgentQueue(),
			() => now,
			undefined,
			target.registry,
		);
		const created = service.create(
			'tenant-a',
			configuringUser,
			{
				targetKind: 'workflow',
				targetKey: 'party-review',
				label: 'Party webhook',
				enabled: true,
			},
			scopes,
		);
		const body = '{"partyId":"party-1","approved":true}';
		const timestamp = String(now);
		const digest = triggerSignature(
			created.secret,
			triggerSignedPayload(timestamp, body),
		);
		const request = {
			triggerId: created.trigger.id,
			body,
			timestamp,
			signature: `v1=${digest}`,
		};

		const first = await service.fire(request);
		const retry = await service.fire(request);
		expect(retry.id).toBe(first.id);
		expect(target.invocations).toHaveLength(2);
		expect(target.invocations[0]).toEqual({
			request: {
				targetKey: 'party-review',
				input: { partyId: 'party-1', approved: true },
			},
			context: {
				tenantId: 'tenant-a',
				configuredBy: configuringUser,
				permissionSnapshot: [...scopes].sort(),
				source: {
					kind: 'webhook',
					triggerId: created.trigger.id,
					acceptedSignatureDigest: digest,
				},
			},
		});
		expect(repository.getTrigger('tenant-a', created.trigger.id)).toMatchObject(
			{
				acceptedCount: 1,
				configuredBy: configuringUser,
				permissionSnapshot: [...scopes].sort(),
			},
		);
	});

	it('retains a configured workflow while its adapter is unavailable', async () => {
		let now = 2_000;
		let available = true;
		const repository = new SqliteAutomationsRepository(':memory:');
		const target = targetFixture();
		const adapter = target.registry.get('workflow')!;
		const registry = createAutomationTargetRegistry();
		registry.register({ ...adapter, available: () => available });
		const service = new AutomationScheduleService(
			repository,
			noAgentQueue(),
			() => now,
			new AbortController().signal,
			undefined,
			registry,
		);
		const created = service.create(
			'tenant-a',
			configuringUser,
			{
				targetKind: 'workflow',
				targetKey: 'party-review',
				label: 'Retained workflow',
				inputTemplate: '{}',
				cadence: 'every:1',
				enabled: true,
			},
			scopes,
		);
		available = false;
		now += 60_000;
		expect(await service.tick()).toBe(0);
		expect(service.get('tenant-a', created.id)).toMatchObject({
			targetKind: 'workflow',
			targetKey: 'party-review',
			targetAvailable: false,
			enabled: false,
		});
		expect(target.invocations).toHaveLength(0);
	});
});
