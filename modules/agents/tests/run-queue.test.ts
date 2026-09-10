import {
	AgentHarness,
	type AgentProvider,
	type AgentTool,
} from '@flowdular/harness';
import { userActor } from '@flowdular/kernel';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type { CreateAgentInput } from '../src/domain/types.ts';
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
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		finishReason: 'stop',
	}),
};

const readTool: AgentTool = {
	id: 'parties.customer.read',
	transport: 'api',
	target: 'parties.records.get',
	description: 'Read one customer.',
	requiredPermissions: ['parties.records.read'],
	execute: async () => ({ name: 'Ada' }),
};

const agentInput: CreateAgentInput = {
	key: 'customer-reader',
	name: 'Customer reader',
	description: 'Reads customer records through the approved tool.',
	instructions: 'Read only the customer records required for the request.',
	provider: provider.id,
	model: 'test-model',
	allowedTools: [readTool.id],
	procedureIds: [],
	maxSteps: 4,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

let database: AgentsTestDatabase;
const workers: AgentWorker[] = [];

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

afterEach(async () => {
	for (const worker of workers.splice(0)) await worker.dispose();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

function trackedWorker(harness: AgentHarness, workerId: string): AgentWorker {
	const worker = new AgentWorker(database.repository, harness, {
		workerId,
		concurrency: 1,
		leaseMs: 1_000,
	});
	workers.push(worker);
	return worker;
}

async function fixture() {
	const repository = database.repository;
	const harness = new AgentHarness({
		providers: [provider],
		tools: [readTool],
	});
	const worker = trackedWorker(harness, 'worker:run-queue-test');
	const service = new AgentService(repository, harness, worker);
	const created = await service.createAgent('tenant-a', 'owner-a', agentInput);
	const agent = await service.updateAgent('tenant-a', created.id, 'owner-a', {
		...agentInput,
		status: 'active',
		expectedRevision: created.revision,
	});
	return { repository, service, queue: createAgentRunQueue(service), agent };
}

const actor = userActor({
	accountId: 'account-a',
	displayName: 'Ada',
	email: 'ada@example.com',
});

describe('agents.run-queue capability', () => {
	it('stores the explicit request separately from its permission ceiling', async () => {
		const { queue, agent } = await fixture();
		const run = await queue.enqueue(
			{
				tenantId: 'tenant-a',
				actor,
				permissionSnapshot: [],
			},
			{
				agentId: agent.id,
				trigger: 'service',
				input: 'Read the customer.',
				toolGrants: [readTool.id],
			},
		);

		expect(run.permissionSnapshot).toEqual([]);
		expect(run.toolGrants).toEqual([readTool.id]);
	});

	it('keeps an explicit grant when every side of the access contract agrees', async () => {
		const { queue, agent } = await fixture();
		const run = await queue.enqueue(
			{
				tenantId: 'tenant-a',
				actor,
				permissionSnapshot: ['parties.records.read'],
			},
			{
				agentId: agent.id,
				trigger: 'service',
				input: 'Read the customer.',
				toolGrants: [readTool.id],
			},
		);

		expect(run.permissionSnapshot).toEqual(['parties.records.read']);
		expect(run.toolGrants).toEqual([readTool.id]);
	});

	it('refuses a grant outside the agent definition before a run is persisted', async () => {
		const { queue, service, agent } = await fixture();
		await expect(
			queue.enqueue(
				{
					tenantId: 'tenant-a',
					actor,
					permissionSnapshot: ['catalog.items.read'],
				},
				{
					agentId: agent.id,
					trigger: 'service',
					input: 'Read catalog items.',
					toolGrants: ['catalog.item.list'],
				},
			),
		).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED', status: 403 });
		expect(await service.listRuns('tenant-a')).toEqual([]);
	});

	it('cannot combine an actor from one tenant with a run in another tenant', async () => {
		const { queue, agent } = await fixture();
		await expect(
			queue.enqueue(
				{
					tenantId: 'tenant-b',
					actor,
					permissionSnapshot: ['parties.records.read'],
				},
				{
					agentId: agent.id,
					trigger: 'service',
					input: 'Read the customer.',
					toolGrants: [readTool.id],
				},
			),
		).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 });
	});

	it('returns an idempotent retry before current agent and tool checks', async () => {
		const { repository, service, queue, agent } = await fixture();
		const input = {
			agentId: agent.id,
			trigger: 'service' as const,
			input: 'Read the customer.',
			toolGrants: [readTool.id],
			idempotencyKey: 'stable-request-1',
		};
		const first = await queue.enqueue(
			{
				tenantId: 'tenant-a',
				actor,
				permissionSnapshot: ['parties.records.read'],
			},
			input,
		);
		await service.updateAgent('tenant-a', agent.id, 'owner-a', {
			...agentInput,
			name: 'Changed reader',
			status: 'paused',
			expectedRevision: agent.revision,
		});
		const noToolsHarness = new AgentHarness({ providers: [provider] });
		const noToolsWorker = trackedWorker(noToolsHarness, 'worker:no-tools');
		const retryQueue = createAgentRunQueue(
			new AgentService(repository, noToolsHarness, noToolsWorker),
		);

		const retried = await retryQueue.enqueue(
			{
				tenantId: 'tenant-a',
				actor,
				permissionSnapshot: ['parties.records.read'],
			},
			input,
		);
		expect(retried.id).toBe(first.id);
		await expect(
			retryQueue.enqueue(
				{
					tenantId: 'tenant-a',
					actor,
					permissionSnapshot: ['parties.records.read'],
				},
				{ ...input, input: 'A different request.' },
			),
		).rejects.toMatchObject({ code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT' });
	});

	it('refuses a new run when an allowed tool is no longer registered', async () => {
		const { repository, agent } = await fixture();
		const noToolsHarness = new AgentHarness({ providers: [provider] });
		const noToolsWorker = trackedWorker(noToolsHarness, 'worker:no-tools');
		const queue = createAgentRunQueue(
			new AgentService(repository, noToolsHarness, noToolsWorker),
		);

		await expect(
			queue.enqueue(
				{
					tenantId: 'tenant-a',
					actor,
					permissionSnapshot: ['parties.records.read'],
				},
				{
					agentId: agent.id,
					trigger: 'service',
					input: 'Read the customer.',
					toolGrants: [readTool.id],
				},
			),
		).rejects.toMatchObject({ code: 'TOOL_NOT_AVAILABLE' });
	});

	it('does not execute a queued tool after the initiating user loses its scope', async () => {
		let livePermissions = ['parties.records.read'];
		let mutations = 0;
		let releaseProvider!: () => void;
		let providerStarted!: () => void;
		const started = new Promise<void>((resolve) => (providerStarted = resolve));
		const release = new Promise<void>((resolve) => (releaseProvider = resolve));
		const gatedProvider: AgentProvider = {
			id: 'gated-provider',
			execute: async (context) => {
				providerStarted();
				await release;
				await context.invokeTool(readTool.id, {});
				return {
					output: 'done',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const guardedTool: AgentTool = {
			...readTool,
			execute: async () => {
				mutations += 1;
				return { ok: true };
			},
		};
		const repository = database.repository;
		const harness = new AgentHarness({
			providers: [gatedProvider],
			tools: [guardedTool],
			authorizeToolAccess: () => livePermissions,
		});
		const worker = trackedWorker(harness, 'worker:live-revocation');
		const service = new AgentService(repository, harness, worker);
		const created = await service.createAgent('tenant-a', 'owner-a', {
			...agentInput,
			provider: gatedProvider.id,
		});
		const active = await service.updateAgent(
			'tenant-a',
			created.id,
			'owner-a',
			{
				...agentInput,
				provider: gatedProvider.id,
				status: 'active',
				expectedRevision: created.revision,
			},
		);
		const run = await createAgentRunQueue(service).enqueue(
			{
				tenantId: 'tenant-a',
				actor,
				permissionSnapshot: ['parties.records.read'],
			},
			{
				agentId: active.id,
				trigger: 'service',
				input: 'Read the customer.',
				toolGrants: [readTool.id],
			},
		);
		await worker.start();
		await started;
		livePermissions = [];
		releaseProvider();
		for (let attempt = 0; attempt < 300; attempt += 1) {
			if ((await service.getRun('tenant-a', run.id)).status === 'failed') break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(mutations).toBe(0);
		expect(await service.getRun('tenant-a', run.id)).toMatchObject({
			status: 'failed',
			failureCode: 'TOOL_AUTHORIZATION_REVOKED',
		});
	});
});
