import type { DatabaseAdapterLease } from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	AgentHarness,
	type AgentProvider,
	type AgentTool,
} from '@flowdular/harness';
import { defineAgent } from '../src/server/define-agent.ts';
import { createAgentRunQueue } from '../src/server/run-queue.ts';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

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

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

function fixture() {
	const repository = database.repository;
	const harness = new AgentHarness({
		providers: [provider],
		tools: [readTool, writeTool],
	});
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:module-agent-test',
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	const service = new AgentService(repository, harness, worker);
	return { repository, service, worker };
}

async function bind(
	service: AgentService,
	tenantId: string,
	enabledTools: readonly string[] = [readTool.id],
) {
	return await service.configureModuleAgent(tenantId, 'owner-a', {
		agentId: definition().id,
		provider: provider.id,
		model: 'test-model',
		enabledTools,
		status: 'active',
		expectedRevision: 0,
	});
}

describe('module-owned business agents', () => {
	it('validates and deeply freezes a module definition without deployment data', async () => {
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

	it('lists an unconfigured module agent and creates tenant-isolated bindings', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		expect(await service.listModuleAgents('tenant-a')).toMatchObject([
			{
				status: 'unconfigured',
				provider: null,
				revision: null,
				ownership: { kind: 'module', moduleId: 'catalog.core' },
			},
		]);

		const first = await bind(service, 'tenant-a', [readTool.id]);
		const second = await bind(service, 'tenant-b', [writeTool.id]);
		expect(first).toMatchObject({
			status: 'active',
			enabledTools: [readTool.id],
			revision: 1,
			bindingRevision: 1,
		});
		expect(second.enabledTools).toEqual([writeTool.id]);
		expect(
			(await repository.getModuleAgentBinding('tenant-a', definition().id))
				?.enabledTools,
		).toEqual([readTool.id]);
		expect(
			(await repository.listAuditEvents('tenant-a', 10)).map(
				(event) => event.action,
			),
		).toEqual(['module-agent.binding-created']);
	});

	it('enforces the code allowlist, binding reduction, invocation grants, and actor permissions', async () => {
		const { service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		await bind(service, 'tenant-a', [readTool.id]);
		const queue = createAgentRunQueue(service);
		expect(await queue.listAgents('tenant-a')).toMatchObject([
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

	it('AGENTS-MODULE-REVISION advances a binding on its first request after a higher revision, keeps the old snapshot, rejects drift and supersedes a lower revision', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition(1)]);
		await bind(service, 'tenant-a');
		await service.reconcileModuleAgents([definition(2, 'Catalog curator v2')]);
		expect(
			await repository.getModuleAgentBinding('tenant-a', definition().id),
		).toMatchObject({ moduleDefinitionRevision: 1, executableRevision: 1 });

		expect(await service.listModuleAgents('tenant-a')).toMatchObject([
			{ status: 'active', revision: 2, name: 'Catalog curator v2' },
		]);
		expect(
			await repository.getModuleAgentBinding('tenant-a', definition().id),
		).toMatchObject({
			moduleDefinitionRevision: 2,
			executableRevision: 2,
		});
		expect(
			await repository.getAgentRevision('tenant-a', definition().id, 1),
		).toMatchObject({
			name: 'Catalog curator',
			ownership: { kind: 'module', definitionRevision: 1 },
		});
		expect(
			await repository.getAgentRevision('tenant-a', definition().id, 2),
		).toMatchObject({
			name: 'Catalog curator v2',
			ownership: { kind: 'module', definitionRevision: 2 },
		});
		expect(
			(await repository.listAuditEvents('tenant-a', 10)).map(
				(event) => event.action,
			),
		).toEqual([
			'module-agent.definition-reconciled',
			'module-agent.binding-created',
		]);
		await expect(
			service.reconcileModuleAgents([definition(2, 'Changed without a bump')]),
		).rejects.toThrow(/MODULE_AGENT_REVISION_DRIFT/);

		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const older = fixture().service;
		await older.reconcileModuleAgents([definition(1)]);
		expect(await older.listModuleAgents('tenant-a')).toMatchObject([
			{
				status: 'unavailable',
				unavailableReason: expect.stringMatching(
					/^MODULE_AGENT_REVISION_SUPERSEDED/,
				),
			},
		]);
		expect(
			await repository.getModuleAgentBinding('tenant-a', definition().id),
		).toMatchObject({ moduleDefinitionRevision: 2, executableRevision: 2 });
	});

	it('rolls back a binding when its audit evidence cannot be written', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		await owner.database.execute({
			text: `CREATE TRIGGER fail_module_agent_audit
			       BEFORE INSERT ON agent_audit_events_v4
			       FOR EACH ROW EXECUTE FUNCTION flowdular_reject_change('audit unavailable')`,
		});

		try {
			await expect(bind(service, 'tenant-a')).rejects.toThrow(
				/audit unavailable/,
			);
		} finally {
			await owner.database.execute({
				text: 'DROP TRIGGER fail_module_agent_audit ON agent_audit_events_v4',
			});
		}

		expect(
			await repository.getModuleAgentBinding('tenant-a', definition().id),
		).toBeNull();
		expect(
			await repository.getAgentRevision('tenant-a', definition().id, 1),
		).toBeNull();
	});

	it('AGENTS-WORKER-BINDING-PASS skips a failing workspace without logging it and advances it on a later pass without duplicating retained revisions', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		const tenants = ['tenant-a', 'tenant-b', 'tenant-c'];
		for (const tenant of tenants) await bind(service, tenant);
		const served = fixture().service;
		await served.reconcileModuleAgents([definition(2, 'Updated curator')]);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		await owner.database.execute({
			text: `CREATE TRIGGER fail_reconciliation_audit BEFORE INSERT ON agent_audit_events_v4
			FOR EACH ROW WHEN (NEW.tenant_id = 'tenant-b' AND NEW.action = 'module-agent.definition-reconciled')
			EXECUTE FUNCTION flowdular_reject_change('reconciliation audit unavailable')`,
		});
		try {
			await served.advanceStaleModuleAgentBindings();
		} finally {
			await owner.database.execute({
				text: 'DROP TRIGGER fail_reconciliation_audit ON agent_audit_events_v4',
			});
		}
		expect(logged).toHaveBeenCalledTimes(1);
		expect(String(logged.mock.calls[0]![0])).toMatch(
			/binding pass skipped a workspace/,
		);
		expect(JSON.stringify(logged.mock.calls)).not.toMatch(/tenant-/);
		expect(
			await Promise.all(
				tenants.map(
					async (tenant) =>
						(await repository.getModuleAgentBinding(tenant, definition().id))
							?.moduleDefinitionRevision,
				),
			),
		).toEqual([2, 1, 2]);

		await served.advanceStaleModuleAgentBindings();
		await served.advanceStaleModuleAgentBindings();
		for (const tenant of tenants) {
			expect(
				await repository.getModuleAgentBinding(tenant, definition().id),
			).toMatchObject({ revision: 2, moduleDefinitionRevision: 2 });
			expect(
				await repository.getAgentRevision(tenant, definition().id, 1),
			).not.toBeNull();
			expect(
				await repository.getAgentRevision(tenant, definition().id, 2),
			).not.toBeNull();
			expect(
				(await repository.listAuditEvents(tenant, 20)).filter(
					(event) => event.action === 'module-agent.definition-reconciled',
				),
			).toHaveLength(1);
		}
		expect(logged).toHaveBeenCalledTimes(1);
	});

	it('grants the background passes only routing columns and revisions, never instructions or writes', async () => {
		const { service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		await bind(service, 'tenant-a');
		const background = await database.databases.acquire({
			namespace: 'agents.core',
			purpose: 'background',
		});
		try {
			expect(
				(
					await background.database.query({
						text: 'SELECT tenant_id, agent_id FROM module_agent_bindings',
					})
				).rows,
			).toEqual([{ tenant_id: 'tenant-a', agent_id: definition().id }]);
			expect(
				(
					await background.database.query({
						text: 'SELECT module_definition_revision FROM module_agent_bindings',
					})
				).rows,
			).toEqual([{ module_definition_revision: 1 }]);
			expect(
				(
					await background.database.query({
						text: `SELECT tenant_id, id, revision FROM agent_definitions
						       WHERE tenant_id = 'tenant-a'`,
					})
				).rows,
			).toEqual([]);
			expect(
				(
					await background.database.query({
						text: 'SELECT tenant_id, agent_id, revision FROM agent_definition_revisions',
					})
				).rows,
			).toEqual([
				{ tenant_id: 'tenant-a', agent_id: definition().id, revision: 1 },
			]);
			for (const text of [
				'SELECT instructions FROM agent_definitions',
				'SELECT provider FROM module_agent_bindings',
				'SELECT instructions FROM agent_definition_revisions',
				'SELECT name FROM agent_definition_revisions',
			]) {
				await expect(background.database.query({ text })).rejects.toMatchObject(
					{ code: '42501' },
				);
			}
			await expect(
				background.database.execute({
					text: "DELETE FROM module_agent_bindings WHERE tenant_id = 'tenant-a'",
				}),
			).rejects.toMatchObject({ code: '42501' });
		} finally {
			await background.release();
		}
	});

	it('executes a pinned revision after the current binding and code advance', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition(1)]);
		await bind(service, 'tenant-a', [readTool.id]);
		await service.configureModuleAgent('tenant-a', 'owner-a', {
			agentId: definition().id,
			provider: provider.id,
			model: 'new-model',
			enabledTools: [],
			status: 'active',
			expectedRevision: 1,
		});
		await service.reconcileModuleAgents([definition(2, 'Catalog curator v2')]);

		expect(
			await service.getRevisionReference('tenant-a', definition().id, 1),
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
		expect(await repository.getRun('tenant-a', accepted.runId)).toMatchObject({
			agentRevision: 1,
			agentName: 'Catalog curator',
			provider: provider.id,
			model: 'test-model',
			toolGrants: [readTool.id],
		});
	});

	it('keeps retained evidence but refuses new work after module removal', async () => {
		const { repository, service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		await bind(service, 'tenant-a');
		await service.reconcileModuleAgents([]);

		expect(
			await repository.getAgentRevision('tenant-a', definition().id, 1),
		).toMatchObject({ ownership: { kind: 'module' } });
		expect(await service.listModuleAgents('tenant-a')).toEqual([]);
		expect(
			await service.getRevisionReference('tenant-a', definition().id, 1),
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

	it('keeps module behavior read-only and uses optimistic binding revisions', async () => {
		const { service } = fixture();
		await service.reconcileModuleAgents([definition()]);
		const bound = await bind(service, 'tenant-a');
		const paused = await service.configureModuleAgent('tenant-a', 'owner-a', {
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
			procedureIds: [],
			maxSteps: 1,
			timeoutMs: 1_000,
			temperature: 0,
			status: 'paused' as const,
			expectedRevision: 1,
		};
		await expect(
			service.updateAgent('tenant-a', definition().id, 'owner-a', input),
		).rejects.toMatchObject({ code: 'MODULE_AGENT_READ_ONLY' });
		await expect(
			service.configureModuleAgent('tenant-a', 'owner-a', {
				agentId: definition().id,
				provider: provider.id,
				model: 'test-model',
				enabledTools: [],
				status: 'paused',
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({
			code: 'MODULE_AGENT_BINDING_REVISION_CONFLICT',
		});
	});
});
