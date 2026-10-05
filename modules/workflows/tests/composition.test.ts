import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@flowdular/database';
import { createPlatformCapabilityRegistry } from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY_V2,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapabilityV2,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import type { JsonValue, WorkflowGraphV1 } from '../src/domain/types.ts';
import { createServerComposition } from '../src/platform.ts';
import { DatabaseWorkflowsRepository } from '../src/services/database-repository.ts';
import {
	createWorkflowsTestProvider,
	withOwnerHandle,
} from './support/database.ts';
import {
	authRuntime,
	principal,
	sessionClient,
	type SessionClient,
} from './support/harness.ts';

const POLL_MS = 250;
/* Both roles derive their payload and cursor keys from the same root, as two
   processes of one deployment do from shared secrets. */
const ENVIRONMENT = {
	NODE_ENV: 'test',
	FD_WORKFLOWS_WORKER_POLL_MS: String(POLL_MS),
	FD_WORKFLOWS_WORKER_LEASE_MS: '1000',
};
const WORKSPACE_ROOT = '/workflows-composition-test';

const schema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
} as const;

function agentGraph(): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'schema.data' }],
			},
			{
				id: 'agent.process',
				label: 'Agent',
				type: 'agent',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [
					{ name: 'success', schemaId: 'schema.data' },
					{ name: 'failure', schemaId: 'schema.error' },
				],
				agent: { agentId: 'agent-1', revision: 3 },
				toolGrants: [],
				outputSchemaId: 'schema.data',
				failurePolicy: {
					maxAttempts: 1,
					retryOn: [],
					backoff: { kind: 'fixed', initialMs: 1, maximumMs: 1 },
					onExhausted: 'fail-run',
				},
			},
			{
				id: 'output.success',
				label: 'Success',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
			{
				id: 'output.failure',
				label: 'Failure',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.error' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.agent',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'agent.process', port: 'input' },
			},
			{
				id: 'edge.success',
				source: { nodeId: 'agent.process', port: 'success' },
				target: { nodeId: 'output.success', port: 'input' },
			},
			{
				id: 'edge.failure',
				source: { nodeId: 'agent.process', port: 'failure' },
				target: { nodeId: 'output.failure', port: 'input' },
			},
		],
		schemas: {
			'schema.data': schema,
			'schema.error': {
				type: 'object',
				required: ['code'],
				properties: { code: { type: 'string' } },
			},
		},
		layout: {
			'input.start': { x: 0, y: 0 },
			'agent.process': { x: 250, y: 0 },
			'output.success': { x: 500, y: -100 },
			'output.failure': { x: 500, y: 100 },
		},
	};
}

/* One agent fake shared by every role of a test, so a child run created by
   one process is the child another process observes. */
function agentFake(initial: JsonValue | null) {
	const children = new Set<string>();
	const calls: {
		readonly agentId: string;
		readonly revision: number;
		readonly subject: string | undefined;
	}[] = [];
	let result = initial;
	let hold: Promise<void> | null = null;
	let release = () => {};
	const revision = {
		agentId: 'agent-1',
		revision: 3,
		name: 'Agent',
		status: 'active',
		supportsStructuredOutput: true,
		allowedTools: [],
	} as const;
	const agents: AgentRevisionExecutionCapability = {
		listRevisions: async () => [revision],
		getRevision: async () => revision,
		enqueueRevision: async (request, context) => {
			calls.push({
				agentId: request.agentId,
				revision: request.revision,
				subject: context.authorizationSubject?.id,
			});
			if (hold) await hold;
			const created = !children.has(request.idempotencyKey);
			children.add(request.idempotencyKey);
			return { runId: `child:${request.idempotencyKey}`, created };
		},
		readEvents: async () => [],
		getResult: async (runId) =>
			result === null
				? null
				: {
						runId,
						status: 'succeeded',
						output: null,
						structuredOutput: result,
						usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
						failureCode: null,
						completedAt: Date.now(),
					},
		requestCancel: async () => true,
	};
	return {
		agents,
		calls,
		children: () => children.size,
		finish: (value: JsonValue) => {
			result = value;
		},
		hold: () => {
			hold = new Promise((resolve) => {
				release = () => {
					hold = null;
					resolve();
				};
			});
		},
		release: () => release(),
	};
}

const actions: AgentActionExecutionCapabilityV2 = {
	listWorkflowActions: async () => [],
	start: async () => {
		throw new Error('No action node is expected in this test.');
	},
	getResult: async () => null,
	requestCancel: async (actionInvocationId) => ({
		actionInvocationId,
		state: 'not-supported',
	}),
};

/* One process of a deployment: its own composition and capability registry
   over the shared database, with a browser session in front of its routes. */
function compose(
	databases: DatabaseProvider,
	agents: AgentRevisionExecutionCapability,
) {
	const capabilities = createPlatformCapabilityRegistry();
	capabilities.register(AGENT_RUN_EXECUTION_CAPABILITY, agents);
	capabilities.register(AGENT_ACTION_EXECUTION_CAPABILITY_V2, actions);
	const auth = authRuntime(principal());
	const composition = createServerComposition({
		environment: ENVIRONMENT,
		workspaceRoot: WORKSPACE_ROOT,
		databases,
		capabilities,
		auth,
		dataClasses: { declare: () => undefined },
	} as never);
	return { composition, client: sessionClient(composition.routes, auth) };
}

async function publish(client: SessionClient, key: string): Promise<void> {
	const created = await client.mutation('/api/workflows', {
		key,
		name: 'Lifecycle',
		description: '',
	});
	expect(created.status).toBe(201);
	const { definition } = await created.json();
	const updated = await client.mutation('/api/workflows/update', {
		workflowId: definition.id,
		expectedRevision: 1,
		name: 'Lifecycle',
		description: '',
		graph: agentGraph(),
	});
	expect(updated.status).toBe(200);
	const published = await client.mutation('/api/workflows/publish', {
		workflowId: definition.id,
		expectedRevision: 2,
	});
	expect(published.status).toBe(200);
}

async function enqueue(
	client: SessionClient,
	key: string,
	idempotencyKey: string,
): Promise<{ runId: string; workflowRevision: number; status: string }> {
	const response = await client.mutation('/api/workflow-runs', {
		workflowKey: key,
		input: { name: 'Ada' },
		idempotencyKey,
	});
	expect(response.status).toBe(202);
	return (await response.json()).accepted;
}

async function runRow(databases: DatabaseProvider, runId: string) {
	const result = await withOwnerHandle(databases, (owner) =>
		owner.transaction(
			(transaction) =>
				transaction.query<{ status: string; lease_owner: string | null }>({
					text: 'SELECT status, lease_owner FROM workflow_runs WHERE id = $1',
					parameters: [runId] as never,
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		),
	);
	return result.rows[0];
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeout = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for workflow state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/* Long enough for several polls of a started worker to have claimed. */
const idleLongerThanPolls = () =>
	new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('workflows.core composition', () => {
	it('WORKFLOWS-WEB-WORKER-ROLE persists a web enqueue without a claim and the worker role runs it pinned', async () => {
		const databases = createWorkflowsTestProvider();
		const fake = agentFake({ name: 'Ada' });
		const web = compose(databases, fake.agents);
		const worker = compose(databases, fake.agents);
		const claims = vi.spyOn(DatabaseWorkflowsRepository.prototype, 'claimNext');
		try {
			web.composition.start?.();
			await publish(web.client, 'web-role');
			const accepted = await enqueue(web.client, 'web-role', 'web-role:1');
			expect(accepted).toMatchObject({ workflowRevision: 2, status: 'queued' });
			await idleLongerThanPolls();

			expect(claims).not.toHaveBeenCalled();
			expect(fake.calls).toEqual([]);
			expect(await runRow(databases, accepted.runId)).toEqual({
				status: 'queued',
				lease_owner: null,
			});

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await waitFor(
				async () =>
					(await runRow(databases, accepted.runId))?.status === 'succeeded',
			);
			expect(fake.calls).toEqual([
				{ agentId: 'agent-1', revision: 3, subject: 'account-a' },
			]);
		} finally {
			await web.composition.stop?.();
			await web.composition.dispose?.();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
			await databases.dispose();
		}
	});

	it('WORKFLOWS-WEB-WORKER-ROLE stops without startWorker, ignores a start a stop overtook, and restarts after stop', async () => {
		const databases = createWorkflowsTestProvider();
		const fake = agentFake({ name: 'Ada' });
		const untouched = compose(databases, fake.agents);
		const worker = compose(databases, fake.agents);
		try {
			await untouched.composition.stop?.();
			await untouched.composition.dispose?.();

			const starting = worker.composition.startWorker?.();
			await worker.composition.stop?.();
			await starting;
			await publish(worker.client, 'restart');
			const first = await enqueue(worker.client, 'restart', 'restart:1');
			await idleLongerThanPolls();
			expect(await runRow(databases, first.runId)).toEqual({
				status: 'queued',
				lease_owner: null,
			});

			await worker.composition.startWorker?.();
			await waitFor(
				async () =>
					(await runRow(databases, first.runId))?.status === 'succeeded',
			);
			await worker.composition.stop?.();
			const second = await enqueue(worker.client, 'restart', 'restart:2');
			await idleLongerThanPolls();
			expect(await runRow(databases, second.runId)).toEqual({
				status: 'queued',
				lease_owner: null,
			});

			await worker.composition.startWorker?.();
			await waitFor(
				async () =>
					(await runRow(databases, second.runId))?.status === 'succeeded',
			);
			expect(fake.children()).toBe(2);
		} finally {
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
			await databases.dispose();
		}
	});

	it('WORKFLOWS-WORKER-DRAIN waits for the executing node, takes no new run and leaves the run to recovery', async () => {
		const databases = createWorkflowsTestProvider();
		const fake = agentFake(null);
		const stopping = compose(databases, fake.agents);
		const recovering = compose(databases, fake.agents);
		try {
			await publish(stopping.client, 'drain');
			const executing = await enqueue(stopping.client, 'drain', 'drain-run:1');
			fake.hold();
			await stopping.composition.startWorker?.();
			await waitFor(() => fake.calls.length === 1);
			expect((await runRow(databases, executing.runId))?.lease_owner).toEqual(
				expect.any(String),
			);

			let stopped = false;
			const stop = Promise.resolve(stopping.composition.stop?.()).then(() => {
				stopped = true;
			});
			const waiting = await enqueue(stopping.client, 'drain', 'drain-run:2');
			await idleLongerThanPolls();
			expect(stopped).toBe(false);

			fake.release();
			await stop;
			expect(await runRow(databases, executing.runId)).toEqual({
				status: 'waiting-agent',
				lease_owner: null,
			});
			expect(await runRow(databases, waiting.runId)).toEqual({
				status: 'queued',
				lease_owner: null,
			});
			await stopping.composition.dispose?.();

			fake.finish({ name: 'Ada' });
			await recovering.composition.startWorker?.();
			await waitFor(async () => {
				const [first, second] = await Promise.all([
					runRow(databases, executing.runId),
					runRow(databases, waiting.runId),
				]);
				return first?.status === 'succeeded' && second?.status === 'succeeded';
			});
			expect(fake.children()).toBe(2);
			expect(fake.calls).toHaveLength(2);
		} finally {
			fake.release();
			await stopping.composition.stop?.();
			await stopping.composition.dispose?.();
			await recovering.composition.stop?.();
			await recovering.composition.dispose?.();
			await databases.dispose();
		}
	});

	it('WORKFLOWS-WORKER-DRAIN claims nothing once a stop arrives during a pass', async () => {
		const databases = createWorkflowsTestProvider();
		const fake = agentFake({ name: 'Ada' });
		const worker = compose(databases, fake.agents);
		const retention =
			DatabaseWorkflowsRepository.prototype.applyPayloadRetention;
		let retentionPasses = 0;
		let releaseRetention = () => {};
		const retentionHeld = new Promise<void>((resolve) => {
			releaseRetention = resolve;
		});
		vi.spyOn(
			DatabaseWorkflowsRepository.prototype,
			'applyPayloadRetention',
		).mockImplementation(async function (
			this: DatabaseWorkflowsRepository,
			now: number,
			limit?: number,
		) {
			retentionPasses += 1;
			await retentionHeld;
			return retention.call(this, now, limit);
		});
		const claims = vi.spyOn(DatabaseWorkflowsRepository.prototype, 'claimNext');
		try {
			await publish(worker.client, 'drain-claim');
			const queued = await enqueue(
				worker.client,
				'drain-claim',
				'drain-claim:1',
			);
			await worker.composition.startWorker?.();
			await waitFor(() => retentionPasses === 1);

			const stop = worker.composition.stop?.();
			releaseRetention();
			await stop;
			expect(claims).not.toHaveBeenCalled();
			expect(fake.calls).toEqual([]);
			expect(await runRow(databases, queued.runId)).toEqual({
				status: 'queued',
				lease_owner: null,
			});
		} finally {
			releaseRetention();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
			await databases.dispose();
		}
	});
});
