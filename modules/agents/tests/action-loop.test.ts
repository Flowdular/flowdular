import type { DatabaseAdapterLease } from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type {
	AgentTool,
	AgentToolAuthorizationRequest,
} from '@flowdular/harness';
import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import {
	createAgentActionExecutionRuntime,
	type AgentActionRuntime,
} from '../src/server/action-execution.ts';
import type { AgentRepository } from '../src/services/repository.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-action-loop';
const actor = {
	kind: 'user',
	id: 'owner-action-loop',
	label: 'Action loop owner',
} as const;
const PERMISSION = 'connectors.instances.read';
/** The smallest lease the runtime accepts, so the poll interval is 1000 ms. */
const LEASE_MS = 1_000;

const authorizeRead = (_request: AgentToolAuthorizationRequest) => [PERMISSION];

function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - startedAt > timeoutMs) {
				return reject(new Error('Condition was not met in time.'));
			}
			setTimeout(() => void tick(), 5);
		};
		void tick();
	});
}

/** A complete workflow action contract, so the descriptor publishes it. */
function action(
	execute: (input: unknown) => Promise<{ readonly ok: boolean }>,
): AgentTool {
	return defineApiAgentTool({
		id: 'connectors.call',
		endpointId: 'connectors.calls.agent',
		contractVersion: 1,
		description: 'Call a consented connector instance.',
		requiredPermissions: [PERMISSION],
		risk: 'workspace-write',
		idempotency: 'required',
		idempotencyProtection: 'target-ledger',
		cancellation: 'cooperative',
		inputSchema: {
			type: 'object',
			required: ['instanceId'],
			properties: { instanceId: { type: 'string' } },
			additionalProperties: false,
		},
		outputSchema: {
			type: 'object',
			required: ['ok'],
			properties: { ok: { type: 'boolean' } },
			additionalProperties: false,
		},
		execute,
	});
}

function context(workflowRunId: string, nodeRunId = 'node-1') {
	return {
		tenantId,
		workflowRunId,
		nodeRunId,
		actor,
		permissionSnapshot: [PERMISSION],
		signal: new AbortController().signal,
	};
}

function request(idempotencyKey: string) {
	return {
		actionId: 'connectors.call',
		contractVersion: 1,
		input: { instanceId: 'instance-1' },
		idempotencyKey,
	} as const;
}

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
const runtimes: AgentActionRuntime[] = [];

function trackedRuntime(
	tool: AgentTool,
	workerId: string,
	repository: AgentRepository = database.repository,
): AgentActionRuntime {
	const runtime = createAgentActionExecutionRuntime(repository, [tool], {
		workerId,
		leaseMs: LEASE_MS,
		authorizeToolAccess: authorizeRead,
	});
	runtimes.push(runtime);
	return runtime;
}

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

afterAll(async () => {
	await owner?.release();
	await database.dispose();
});

describe('the action loop', () => {
	it('performs an invocation enqueued during a pass without waiting out the interval', async () => {
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered: string[] = [];
		let secondEnteredAt = 0;
		const runtime = trackedRuntime(
			action(async (input) => {
				const key = (input as { instanceId: string }).instanceId;
				entered.push(key);
				if (key === 'first') await held;
				else secondEnteredAt = Date.now();
				return { ok: true };
			}),
			'action-worker:wake',
		);
		runtime.start();

		await runtime.capability.start(
			{ ...request('workflow-run-wake:first'), input: { instanceId: 'first' } },
			context('workflow-run-wake', 'node-first'),
		);
		await waitFor(() => entered.includes('first'));

		/* The pass in flight has already found the queue empty behind the first
		   invocation, so this one is only reachable by waking the loop. */
		await runtime.capability.start(
			{
				...request('workflow-run-wake:second'),
				input: { instanceId: 'second' },
			},
			context('workflow-run-wake', 'node-second'),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const releasedAt = Date.now();
		release();
		await waitFor(() => entered.includes('second'));

		/* A loop that only ticked would have joined the drained pass and left this
		   invocation until the next poll, a whole interval away. */
		expect(secondEnteredAt - releasedAt).toBeLessThan(LEASE_MS / 4);
	});

	it('renews a lease twice inside its window, so one refused renewal is not the last', async () => {
		const attempts: number[] = [];
		const succeeded: number[] = [];
		let claimedAt = 0;
		const repository = new Proxy(database.repository, {
			get(target, property) {
				const value = Reflect.get(target, property) as unknown;
				if (property === 'renewActionLease') {
					return async (
						...args: Parameters<AgentRepository['renewActionLease']>
					) => {
						attempts.push(Date.now());
						/* The database refused this one statement; the lease is unchanged
						   and the next beat has to land inside the same window. */
						if (attempts.length === 1) throw new Error('connection reset');
						const renewed = await target.renewActionLease(...args);
						succeeded.push(Date.now());
						return renewed;
					};
				}
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as AgentRepository;

		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = trackedRuntime(
			action(async () => {
				claimedAt = Date.now();
				await held;
				return { ok: true };
			}),
			'action-worker:heartbeat',
			repository,
		);
		runtime.start();
		await runtime.capability.start(
			request('workflow-run-heartbeat:node-1'),
			context('workflow-run-heartbeat'),
		);

		await waitFor(() => claimedAt > 0);
		await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 100));
		release();

		const expiresAt = claimedAt + LEASE_MS;
		/* Two beats fit in the lease, so the refused one is not the only chance the
		   claim had to be renewed before it lapsed. */
		expect(
			attempts.filter((at) => at < expiresAt).length,
		).toBeGreaterThanOrEqual(2);
		expect(succeeded[0]).toBeLessThan(expiresAt - LEASE_MS / 10);
	});

	it('hands a claim back to the queue when the stop landed while it was taken', async () => {
		let runtime: AgentActionRuntime | undefined;
		let claims = 0;
		const repository = new Proxy(database.repository, {
			get(target, property) {
				const value = Reflect.get(target, property) as unknown;
				if (property === 'claimAction') {
					return async (
						...args: Parameters<AgentRepository['claimAction']>
					) => {
						claims += 1;
						/* The composition stopped this worker while the claim statement
						   was still in the database. */
						runtime?.stop();
						return target.claimAction(...args);
					};
				}
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as AgentRepository;

		const executed: string[] = [];
		runtime = trackedRuntime(
			action(async () => {
				executed.push('ran');
				return { ok: true };
			}),
			'action-worker:stopped',
			repository,
		);
		const accepted = await runtime.capability.start(
			request('workflow-run-stopped:node-1'),
			context('workflow-run-stopped'),
		);
		runtime.start();

		await waitFor(() => claims > 0);
		await waitFor(async () => {
			const invocation = await database.repository.getAction(
				tenantId,
				accepted.actionInvocationId,
			);
			return invocation?.status === 'queued';
		});

		const invocation = await database.repository.getAction(
			tenantId,
			accepted.actionInvocationId,
		);
		/* Queued again with no lease: the next platform to poll finds it at once
		   rather than waiting out a lease no worker is renewing. */
		expect(invocation).toMatchObject({
			status: 'queued',
			leaseExpiresAt: null,
		});
		expect(executed).toEqual([]);
	});
});
