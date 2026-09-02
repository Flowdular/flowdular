import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	AgentHarness,
	type AgentProvider,
	type AgentTool,
} from '@coreloom/harness';
import { defineAgent } from '../src/server/define-agent.ts';
import { createAgentRunQueue } from '../src/server/run-queue.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import { AgentWorker } from '../src/services/worker.ts';

const provider: AgentProvider = {
	id: 'test-provider',
	execute: async () => ({
		output: 'ok',
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		finishReason: 'stop',
	}),
};

const readTool: AgentTool = {
	id: 'catalog.item.read',
	transport: 'api',
	target: 'catalog.items.get',
	description: 'Read a catalog item.',
	requiredPermissions: ['catalog.items.read'],
	execute: async () => ({ id: 'item-1' }),
};

const writeTool: AgentTool = {
	id: 'catalog.item.update',
	transport: 'api',
	target: 'catalog.items.update',
	description: 'Update a catalog item.',
	requiredPermissions: ['catalog.items.manage'],
	execute: async () => ({ id: 'item-1' }),
};

function definition(revision = 1, name = 'Catalog curator') {
	return defineAgent({
		moduleId: 'catalog.core',
		key: 'catalog-curator',
		definitionRevision: revision,
		name,
		description: 'Reviews and normalizes catalog records.',
		instructions: 'Use only the catalog tools explicitly granted to this run.',
		allowedTools: [readTool.id, writeTool.id],
		limits: {
			maxSteps: 8,
			timeoutMs: 120_000,
			temperature: 0.2,
			maxOutputTokens: 4_096,
		},
	});
}

function fixture() {
	const repository = new SqliteAgentRepository(':memory:');
	const harness = new AgentHarness({
		providers: [provider],
		tools: [readTool, writeTool],
	});
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:module-agent-test',
		concurrency: 1,
		leaseMs: 1_000,
	});
	const service = new AgentService(repository, harness, worker);
	return { repository, service, worker };
}

function bind(
	service: AgentService,
	tenantId: string,
	enabledTools: readonly string[] = [readTool.id],
) {
	return service.configureModuleAgent(tenantId, 'owner-a', {
		agentId: definition().id,
		provider: provider.id,
		model: 'test-model',
		enabledTools,
		status: 'active',
		expectedRevision: 0,
	});
}

describe('module-owned business agents', () => {
	it('validates and deeply freezes a module definition without deployment data', () => {
		const agent = definition();
		expect(agent.id).toBe('module-agent:catalog.core:catalog-curator');
		expect(agent.ownership).toEqual({
			kind: 'module',
			moduleId: 'catalog.core',
			definitionRevision: 1,
		});
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.allowedTools)).toBe(true);
		expect(Object.isFrozen(agent.limits)).toBe(true);
		expect(() =>
			defineAgent({
				...agent,
				allowedTools: ['catalog.*'],
			}),
		).toThrow(/valid identifier/);
	});

	it('lists an unconfigured module agent and creates tenant-isolated bindings', () => {
		const { repository, service } = fixture();
		service.reconcileModuleAgents([definition()]);
		expect(service.listModuleAgents('tenant-a')).toMatchObject([
			{
				status: 'unconfigured',
				provider: null,
				revision: null,
				ownership: { kind: 'module', moduleId: 'catalog.core' },
			},
		]);

		const first = bind(service, 'tenant-a', [readTool.id]);
		const second = bind(service, 'tenant-b', [writeTool.id]);
		expect(first).toMatchObject({
			status: 'active',
			enabledTools: [readTool.id],
			revision: 1,
			bindingRevision: 1,
		});
		expect(second.enabledTools).toEqual([writeTool.id]);
		expect(
			repository.getModuleAgentBinding('tenant-a', definition().id)
				?.enabledTools,
		).toEqual([readTool.id]);
		expect(
			repository.listAuditEvents('tenant-a', 10).map((event) => event.action),
		).toEqual(['module-agent.binding-created']);
	});

	it('enforces the code allowlist, binding reduction, invocation grants, and actor permissions', async () => {
		const { service } = fixture();
		service.reconcileModuleAgents([definition()]);
		bind(service, 'tenant-a', [readTool.id]);
		const queue = createAgentRunQueue(service);
		expect(queue.listAgents('tenant-a')).toMatchObject([
			{
				id: definition().id,
				allowedTools: [readTool.id],
				ownership: { kind: 'module' },
			},
		]);
		await expect(
			queue.enqueue(
				{
					tenantId: 'tenant-a',
					actor: { kind: 'user', id: 'owner-a', label: 'Owner' },
					permissionSnapshot: ['catalog.items.manage'],
				},
				{
					agentId: definition().id,
					trigger: 'service',
					input: 'Update the item.',
					toolGrants: [writeTool.id],
				},
			),
		).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED', status: 403 });

		const queued = await queue.enqueue(
			{
				tenantId: 'tenant-a',
				actor: { kind: 'user', id: 'owner-a', label: 'Owner' },
				permissionSnapshot: ['catalog.items.read'],
			},
			{
				agentId: definition().id,
				trigger: 'service',
				input: 'Read the item.',
				toolGrants: [readTool.id],
			},
		);
		expect(queued).toMatchObject({
			agentId: definition().id,
			agentRevision: 1,
			toolGrants: [readTool.id],
			permissionSnapshot: ['catalog.items.read'],
		});
	});

	it('retains exact executable revisions and rejects code drift or downgrade', () => {
		const { repository, service } = fixture();
		service.reconcileModuleAgents([definition(1)]);
		bind(service, 'tenant-a');
		service.reconcileModuleAgents([definition(2, 'Catalog curator v2')]);

		expect(
			repository.getModuleAgentBinding('tenant-a', definition().id),
		).toMatchObject({
			moduleDefinitionRevision: 2,
			executableRevision: 2,
		});
		expect(
			repository.getAgentRevision('tenant-a', definition().id, 1),
		).toMatchObject({
			name: 'Catalog curator',
			ownership: { kind: 'module', definitionRevision: 1 },
		});
		expect(
			repository.getAgentRevision('tenant-a', definition().id, 2),
		).toMatchObject({
			name: 'Catalog curator v2',
			ownership: { kind: 'module', definitionRevision: 2 },
		});
		expect(
			repository.listAuditEvents('tenant-a', 10).map((event) => event.action),
		).toEqual([
			'module-agent.definition-reconciled',
			'module-agent.binding-created',
		]);
		expect(() =>
			service.reconcileModuleAgents([definition(2, 'Changed without a bump')]),
		).toThrow(/MODULE_AGENT_REVISION_DRIFT/);
		expect(() => service.reconcileModuleAgents([definition(1)])).toThrow(
			/MODULE_AGENT_REVISION_DOWNGRADE/,
		);
	});

	it('rolls back a binding when its audit evidence cannot be written', () => {
		const directory = mkdtempSync(join(tmpdir(), 'module-agent-audit-'));
		const path = join(directory, 'agents.db');
		const repository = new SqliteAgentRepository(path);
		const harness = new AgentHarness({
			providers: [provider],
			tools: [readTool, writeTool],
		});
		const worker = new AgentWorker(repository, harness, {
			workerId: 'worker:module-agent-audit',
			concurrency: 1,
			leaseMs: 1_000,
		});
		const service = new AgentService(repository, harness, worker);
		service.reconcileModuleAgents([definition()]);
		const fault = new DatabaseSync(path);
		fault.exec(`CREATE TRIGGER fail_module_agent_audit
			BEFORE INSERT ON agent_audit_events_v4
			BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
		fault.close();

		expect(() => bind(service, 'tenant-a')).toThrow(/audit unavailable/);
		expect(
			repository.getModuleAgentBinding('tenant-a', definition().id),
		).toBeNull();
		expect(
			repository.getAgentRevision('tenant-a', definition().id, 1),
		).toBeNull();

		repository.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('executes a pinned revision after the current binding and code advance', async () => {
		const { repository, service } = fixture();
		service.reconcileModuleAgents([definition(1)]);
		bind(service, 'tenant-a', [readTool.id]);
		service.configureModuleAgent('tenant-a', 'owner-a', {
			agentId: definition().id,
			provider: provider.id,
			model: 'new-model',
			enabledTools: [],
			status: 'active',
			expectedRevision: 1,
		});
		service.reconcileModuleAgents([definition(2, 'Catalog curator v2')]);

		expect(
			service.getRevisionReference('tenant-a', definition().id, 1),
		).toMatchObject({
			revision: 1,
			name: 'Catalog curator',
			status: 'active',
		});
		const accepted = await service.enqueueRevisionRun(
			{
				tenantId: 'tenant-a',
				workflowRunId: 'workflow-run-1',
				actor: { kind: 'user', id: 'owner-a', label: 'Owner' },
				permissionSnapshot: ['catalog.items.read'],
			},
			{
				agentId: definition().id,
				revision: 1,
				input: 'Read the catalog item.',
				toolGrants: [readTool.id],
				outputContract: { kind: 'text' },
				idempotencyKey: 'workflow-agent-revision-1',
			},
		);
		expect(repository.getRun('tenant-a', accepted.runId)).toMatchObject({
			agentRevision: 1,
			agentName: 'Catalog curator',
			provider: provider.id,
			model: 'test-model',
			toolGrants: [readTool.id],
		});
	});

	it('keeps retained evidence but refuses new work after module removal', async () => {
		const { repository, service } = fixture();
		service.reconcileModuleAgents([definition()]);
		bind(service, 'tenant-a');
		service.reconcileModuleAgents([]);

		expect(
			repository.getAgentRevision('tenant-a', definition().id, 1),
		).toMatchObject({ ownership: { kind: 'module' } });
		expect(service.listModuleAgents('tenant-a')).toEqual([]);
		expect(
			service.getRevisionReference('tenant-a', definition().id, 1),
		).toBeNull();
		await expect(
			service.enqueueRevisionRun(
				{
					tenantId: 'tenant-a',
					workflowRunId: 'workflow-run-removed',
					actor: { kind: 'user', id: 'owner-a', label: 'Owner' },
					permissionSnapshot: ['catalog.items.read'],
				},
				{
					agentId: definition().id,
					revision: 1,
					input: 'Read the catalog item.',
					toolGrants: [],
					outputContract: { kind: 'text' },
					idempotencyKey: 'workflow-agent-removed',
				},
			),
		).rejects.toMatchObject({ code: 'AGENT_REVISION_NOT_FOUND', status: 404 });
	});

	it('keeps module behavior read-only and uses optimistic binding revisions', () => {
		const { service } = fixture();
		service.reconcileModuleAgents([definition()]);
		const bound = bind(service, 'tenant-a');
		const paused = service.configureModuleAgent('tenant-a', 'owner-a', {
			agentId: definition().id,
			provider: provider.id,
			model: 'test-model',
			enabledTools: [readTool.id],
			status: 'paused',
			expectedRevision: bound.bindingRevision!,
		});
		expect(paused).toMatchObject({
			status: 'paused',
			revision: bound.revision,
			bindingRevision: 2,
		});
		const input = {
			key: 'cannot-change',
			name: 'Cannot change',
			description: 'A tenant may not replace module-owned behavior.',
			instructions: 'This must not be persisted.',
			provider: provider.id,
			model: 'test-model',
			allowedTools: [],
			skillIds: [],
			maxSteps: 1,
			timeoutMs: 1_000,
			temperature: 0,
			status: 'paused' as const,
			expectedRevision: 1,
		};
		expect(() =>
			service.updateAgent('tenant-a', definition().id, 'owner-a', input),
		).toThrowError(expect.objectContaining({ code: 'MODULE_AGENT_READ_ONLY' }));
		expect(() =>
			service.configureModuleAgent('tenant-a', 'owner-a', {
				agentId: definition().id,
				provider: provider.id,
				model: 'test-model',
				enabledTools: [],
				status: 'paused',
				expectedRevision: 1,
			}),
		).toThrowError(
			expect.objectContaining({
				code: 'MODULE_AGENT_BINDING_REVISION_CONFLICT',
			}),
		);
	});
});
