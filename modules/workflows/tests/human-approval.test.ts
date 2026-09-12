import { afterEach, describe, expect, it } from 'vitest';
import {
	createPlatformCapabilityRegistry,
	userActor,
	type PlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	type AgentActionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from '@flowdular/module-agents/server';
import { WORKFLOWS_PERMISSIONS } from '../src/acl/permissions.ts';
import { compileWorkflowGraph } from '../src/domain/graph.ts';
import type { WorkflowGraphV1 } from '../src/domain/types.ts';
import { APPROVAL_LIMITS, WORKFLOW_LIMITS } from '../src/domain/types.ts';
import {
	APPROVALS_REQUESTS_CAPABILITY,
	type ApprovalRequest,
	type ApprovalsRequests,
	type OpenApprovalInput,
} from '../src/services/approvals.ts';
import type { WorkflowsService } from '../src/services/workflows-service.ts';
import type { WorkflowsRuntime } from '../src/server/runtime.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';

const tenantId = 'tenant-approval';
const member = 'member-approval';
const actor = userActor({
	accountId: member,
	email: 'member-approval@example.com',
});
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
	'agents.definitions.read',
	'agents.runs.read',
	'agents.runs.execute',
];

const schema = {
	type: 'object',
	required: ['name'],
	properties: { name: { type: 'string' } },
} as const;

function approvalGraph(
	requirement: Record<string, unknown> = { roleKey: 'owner', decisions: 1 },
): WorkflowGraphV1 {
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
				id: 'approval.sign-off',
				label: 'Sign off',
				type: 'human-approval',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [{ name: 'approved', schemaId: 'schema.data' }],
				requirement,
			} as never,
			{
				id: 'output.done',
				label: 'Output',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.to-approval',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'approval.sign-off', port: 'input' },
			},
			{
				id: 'edge.to-output',
				source: { nodeId: 'approval.sign-off', port: 'approved' },
				target: { nodeId: 'output.done', port: 'input' },
			},
		],
		schemas: { 'schema.data': schema },
		layout: {
			'input.start': { x: 0, y: 0 },
			'approval.sign-off': { x: 200, y: 0 },
			'output.done': { x: 400, y: 0 },
		},
	};
}

/* The editor saves a draft the moment a human-approval node is dropped on the
   canvas, before anybody fills the requirement in. */
function requirementless(value?: unknown): WorkflowGraphV1 {
	const graph = approvalGraph();
	const node = graph.nodes[1] as unknown as Record<string, unknown>;
	if (value === undefined) delete node.requirement;
	else node.requirement = value;
	return graph;
}

function agentDependencies() {
	const agents: AgentRevisionExecutionCapability = {
		listDefinitions: async () => [],
		getRevision: async () => null,
		enqueueRevision: async () => ({ runId: 'child', created: true }),
		readEvents: async () => [],
		getResult: async () => null,
		requestCancel: async () => true,
	} as unknown as AgentRevisionExecutionCapability;
	const actions: AgentActionExecutionCapability = {
		listWorkflowActions: async () => [],
		start: async () => ({ actionInvocationId: 'action-1', created: true }),
		getResult: async () => null,
		requestCancel: async (actionInvocationId: string) => ({
			actionInvocationId,
			state: 'acknowledged' as const,
		}),
	} as unknown as AgentActionExecutionCapability;
	return { agents, actions };
}

/**
 * A stand-in for approvals.core with the same contract: it records what was
 * opened and lets a test decide the request the way a person would.
 */
function fakeApprovals(
	options: {
		readonly now?: () => number;
		/* approvals.core may resolve a request inside `open`, which calls back
		   before the caller holds the request it opened. */
		readonly resolveDuringOpen?: ApprovalRequest['status'];
	} = {},
) {
	const now = options.now ?? Date.now;
	const opened: OpenApprovalInput[] = [];
	const requests = new Map<string, ApprovalRequest>();
	const callbacks = new Map<
		string,
		(request: ApprovalRequest) => Promise<void>
	>();
	let counter = 0;
	const capability: ApprovalsRequests = {
		open: async (input) => {
			opened.push(input);
			const existing = [...requests.values()].find(
				(entry) =>
					entry.subjectRef === input.subjectRef && entry.status === 'pending',
			);
			if (existing) return existing;
			counter += 1;
			const request: ApprovalRequest = {
				id: `approval-${counter}`,
				tenantId: input.tenantId,
				subjectModule: input.subjectModule,
				subjectRef: input.subjectRef,
				status: 'pending',
				expiresAt: now() + 7 * 24 * 60 * 60 * 1_000,
				resolvedAt: null,
			};
			requests.set(request.id, request);
			if (input.onResolved) callbacks.set(request.id, input.onResolved);
			if (options.resolveDuringOpen) {
				await input.onResolved?.(
					resolve(request.id, options.resolveDuringOpen),
				);
			}
			return requests.get(request.id)!;
		},
		get: async (_tenantId, id) => requests.get(id) ?? null,
		cancel: async (_tenantId, id) => {
			const request = requests.get(id);
			if (!request) throw new Error('APPROVAL_NOT_FOUND');
			return resolve(id, 'cancelled');
		},
	};
	function resolve(
		id: string,
		status: ApprovalRequest['status'],
	): ApprovalRequest {
		const request = requests.get(id)!;
		const next = { ...request, status, resolvedAt: now() };
		requests.set(id, next);
		return next;
	}
	return {
		capability,
		opened,
		/* What approvals.core does after the deciding transaction commits. */
		async decide(id: string, status: ApprovalRequest['status']) {
			const next = resolve(id, status);
			const callback = callbacks.get(id);
			callbacks.delete(id);
			if (callback) await callback(next);
			return next;
		},
		request: (id: string) => requests.get(id) ?? null,
	};
}

function registry(approvals?: ApprovalsRequests): PlatformCapabilityRegistry {
	const value = createPlatformCapabilityRegistry();
	const fake = agentDependencies();
	value.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
	value.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
	if (approvals) value.register(APPROVALS_REQUESTS_CAPABILITY, approvals);
	return value;
}

const runtimes: WorkflowsRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

function trackedRuntime(
	capabilities: PlatformCapabilityRegistry,
	roleKeys: readonly string[] = ['owner', 'member'],
	now?: () => number,
) {
	const runtime = createWorkflowsTestRuntime({
		capabilities,
		roles: async () => roleKeys,
		payloadKey: Buffer.alloc(32, 7),
		cursorKey: Buffer.alloc(32, 8),
		worker: { pollMs: 100, leaseMs: 5_000, ...(now ? { now } : {}) },
	});
	runtimes.push(runtime);
	return runtime;
}

/* The worker's clock, moved by hand. It starts where the service that stamps
   `queuedAt` is, so a run's age is the time this test advances and no more. */
function workerClock(start = Date.now()) {
	let value = start;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
		set: (next: number) => {
			value = next;
		},
	};
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeout = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for workflow state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function publishedWorkflow(
	service: WorkflowsService,
	key: string,
	graph: WorkflowGraphV1,
): Promise<string> {
	const created = await service.create(
		tenantId,
		{ key, name: 'Sign off', description: '' },
		actor,
	);
	await service.update(
		tenantId,
		{
			workflowId: created.definition.id,
			expectedRevision: 1,
			name: 'Sign off',
			description: '',
			graph,
		},
		actor,
	);
	await service.publish(tenantId, created.definition.id, 2, actor, permissions);
	return created.definition.id;
}

async function startRun(runtime: WorkflowsRuntime, key: string) {
	const service = await runtime.service();
	await publishedWorkflow(service, key, approvalGraph());
	runtime.start();
	const accepted = await service.enqueue(
		{
			workflowKey: key,
			input: { name: 'Ada' },
			idempotencyKey: `${key}:1`,
		},
		{
			tenantId,
			actor,
			origin: { kind: 'manual' } as const,
			permissionSnapshot: permissions,
		},
	);
	return { service, runId: accepted.runId };
}

describe('WORKFLOWS-HUMAN-APPROVAL', () => {
	it('WORKFLOWS-HUMAN-APPROVAL pauses the run on one request and resumes it after the approval', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const { service, runId } = await startRun(runtime, 'approve-resume');

		await waitFor(async () => approvals.opened.length > 0);
		const paused = (await service.getRun(tenantId, runId))!;
		expect(paused.status).toBe('waiting-approval');
		expect(approvals.opened[0]).toMatchObject({
			tenantId,
			subjectModule: 'workflows.core',
			subjectRef: `${runId}:approval.sign-off`,
			requesterAccountId: member,
			requirement: { roleKey: 'owner', decisions: 1 },
		});

		/* The pause has to hold: a run asleep on a person must not be re-claimed
		   every poll, which is what would starve everything queued behind it. */
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect((await service.getRun(tenantId, runId))?.status).toBe(
			'waiting-approval',
		);
		expect(approvals.opened).toHaveLength(1);

		await approvals.decide('approval-1', 'approved');
		await waitFor(
			async () =>
				(await service.getRun(tenantId, runId))?.status === 'succeeded',
		);
		const detail = await service.getRunDetail(tenantId, runId);
		expect(
			detail.nodes.find((entry) => entry.nodeId === 'approval.sign-off')
				?.status,
		).toBe('succeeded');
		expect(
			detail.events.some((entry) => entry.type === 'node.child.waiting'),
		).toBe(true);
	});

	it('WORKFLOWS-HUMAN-APPROVAL keeps a run parked past the live window and withdraws the request at the deadline', async () => {
		const clock = workerClock();
		const approvals = fakeApprovals({ now: clock.now });
		const runtime = trackedRuntime(
			registry(approvals.capability),
			['owner', 'member'],
			clock.now,
		);
		const { service, runId } = await startRun(runtime, 'approve-long-wait');

		await waitFor(async () => approvals.opened.length > 0);
		const deadline = approvals.request('approval-1')!.expiresAt;
		expect(deadline).toBeGreaterThan(
			clock.now() + WORKFLOW_LIMITS.maxLiveDurationMs,
		);

		/* The live window bounds the work a run does, not how long a person takes
		   to answer it: past that window the request is still open and so is the
		   run that is waiting for it. */
		clock.advance(WORKFLOW_LIMITS.maxLiveDurationMs + 60 * 60 * 1_000);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect((await service.getRun(tenantId, runId))?.status).toBe(
			'waiting-approval',
		);
		expect(approvals.request('approval-1')?.status).toBe('pending');

		/* The request's own expiry ends the wait, and takes the request with it
		   rather than leaving deciders asked about a run that has stopped. */
		clock.set(deadline);
		await waitFor(async () => {
			const status = (await service.getRun(tenantId, runId))?.status;
			return status === 'failed' || status === 'refused';
		});
		const run = (await service.getRun(tenantId, runId))!;
		expect(run.failureCode).toBe('WORKFLOW_CHILD_OBSERVATION_TIMEOUT');
		expect(approvals.request('approval-1')?.status).toBe('cancelled');
		expect(approvals.opened).toHaveLength(1);
	});

	it('WORKFLOWS-HUMAN-APPROVAL resumes a run whose request resolved inside the opening call', async () => {
		const approvals = fakeApprovals({ resolveDuringOpen: 'approved' });
		const runtime = trackedRuntime(registry(approvals.capability));
		const { service, runId } = await startRun(runtime, 'approve-during-open');

		await waitFor(async () => approvals.opened.length > 0);
		/* The callback fires before `open` has answered, so the id it needs can
		   only come from the request it is called with, and it reaches an attempt
		   the worker has not armed yet: nothing it does can wake the run. The
		   worker has to look at the request once more after arming it, or this
		   run sleeps until its recheck falls due minutes later. */
		await waitFor(
			async () =>
				(await service.getRun(tenantId, runId))?.status === 'succeeded',
		);
		expect((await service.getRun(tenantId, runId))?.failureCode).toBeNull();
		expect(approvals.opened).toHaveLength(1);
	});

	it('WORKFLOWS-HUMAN-APPROVAL fails the run with a stable code after a rejection', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const { service, runId } = await startRun(runtime, 'approve-reject');

		await waitFor(async () => approvals.opened.length > 0);
		await approvals.decide('approval-1', 'rejected');
		await waitFor(async () => {
			const status = (await service.getRun(tenantId, runId))?.status;
			return status === 'failed' || status === 'refused';
		});
		const run = (await service.getRun(tenantId, runId))!;
		expect(run.status).toBe('failed');
		expect(run.failureCode).toBe('WORKFLOW_APPROVAL_REJECTED');
	});

	it('WORKFLOWS-HUMAN-APPROVAL fails the run with a stable code after an expiry', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const { service, runId } = await startRun(runtime, 'approve-expire');

		await waitFor(async () => approvals.opened.length > 0);
		await approvals.decide('approval-1', 'expired');
		await waitFor(async () => {
			const status = (await service.getRun(tenantId, runId))?.status;
			return status === 'failed' || status === 'refused';
		});
		expect((await service.getRun(tenantId, runId))?.failureCode).toBe(
			'WORKFLOW_APPROVAL_EXPIRED',
		);
	});

	it('WORKFLOWS-HUMAN-APPROVAL withdraws the pending request when the run is cancelled', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const { service, runId } = await startRun(runtime, 'approve-cancel');

		await waitFor(async () => approvals.opened.length > 0);
		await service.cancel(tenantId, runId, actor);
		await waitFor(
			async () =>
				(await service.getRun(tenantId, runId))?.status === 'cancelled',
		);
		expect(approvals.request('approval-1')?.status).toBe('cancelled');
	});

	it('WORKFLOWS-HUMAN-APPROVAL answers a node without a requirement on every entry point', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const service = await runtime.service();
		const context = {
			tenantId,
			actor,
			origin: { kind: 'manual' } as const,
			permissionSnapshot: permissions,
		};
		for (const [label, graph] of [
			['absent', requirementless()],
			['null', requirementless(null)],
		] as const) {
			const report = await service.validate(graph, context);
			expect([label, report.issues.map((issue) => issue.code)]).toEqual([
				label,
				expect.arrayContaining(['WORKFLOW_APPROVAL_REQUIREMENT_INVALID']),
			]);

			/* A draft may be incomplete, so saving one is not the refusal; the
			   refusal is publishing it and rehearsing it. */
			const created = await service.create(
				tenantId,
				{
					key: `approve-requirement-${label}`,
					name: 'Sign off',
					description: '',
				},
				actor,
			);
			await service.update(
				tenantId,
				{
					workflowId: created.definition.id,
					expectedRevision: 1,
					name: 'Sign off',
					description: '',
					graph,
				},
				actor,
			);

			for (const attempt of [
				() =>
					service.publish(
						tenantId,
						created.definition.id,
						2,
						actor,
						permissions,
					),
				() =>
					service.simulate(
						{
							workflowId: created.definition.id,
							input: { name: 'Ada' },
							fixtures: [],
						},
						context,
					),
			]) {
				const failure = await attempt().then(
					() => null,
					(error: unknown) => error,
				);
				expect([label, failure]).toEqual([
					label,
					expect.objectContaining({ code: 'WORKFLOW_GRAPH_INVALID' }),
				]);
				expect([
					label,
					JSON.stringify((failure as { details?: unknown }).details),
				]).toEqual([
					label,
					expect.stringContaining('WORKFLOW_APPROVAL_REQUIREMENT_INVALID'),
				]);
			}
		}
	});

	it('WORKFLOWS-HUMAN-APPROVAL refuses publication when approvals.core is absent', async () => {
		const runtime = trackedRuntime(registry());
		const service = await runtime.service();
		await expect(
			publishedWorkflow(service, 'approve-missing', approvalGraph()),
		).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
	});

	it('WORKFLOWS-HUMAN-APPROVAL refuses publication when the workspace does not define the role', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability), ['member']);
		const service = await runtime.service();
		await expect(
			publishedWorkflow(service, 'approve-unknown-role', approvalGraph()),
		).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
	});

	it('WORKFLOWS-HUMAN-APPROVAL refuses publication of a prompt approvals.core would refuse', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const service = await runtime.service();
		const graph = approvalGraph();
		(graph.nodes[1] as unknown as Record<string, unknown>).prompt = 'a'.repeat(
			APPROVAL_LIMITS.title + 1,
		);

		await expect(
			publishedWorkflow(service, 'approve-long-prompt', graph),
		).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
		/* Nothing was published, so no run reaches the node and nobody is asked a
		   question approvals.core would have refused at the node instead. */
		expect(approvals.opened).toEqual([]);
	});

	it('WORKFLOWS-HUMAN-APPROVAL approves without asking anybody in a simulation', async () => {
		const approvals = fakeApprovals();
		const runtime = trackedRuntime(registry(approvals.capability));
		const service = await runtime.service();
		const workflowId = await publishedWorkflow(
			service,
			'approve-simulate',
			approvalGraph(),
		);
		const detail = await service.simulate(
			{ workflowId, input: { name: 'Ada' }, fixtures: [] },
			{
				tenantId,
				actor,
				origin: { kind: 'manual' },
				permissionSnapshot: permissions,
			},
		);
		expect(detail.run.status).toBe('succeeded');
		expect(
			detail.nodes.find((node) => node.nodeId === 'approval.sign-off')?.status,
		).toBe('succeeded');
		expect(approvals.opened).toHaveLength(0);
	});
});

describe('human-approval graph validation', () => {
	const catalog = (
		available: boolean,
		roleKeys: readonly string[] = ['owner'],
	) => ({
		agent: () => true,
		action: () => ({ available: true, requiredPermissions: [] }),
		approval: () => ({ available, roleKeys }),
	});

	const codes = (graph: WorkflowGraphV1, ...rest: Parameters<typeof catalog>) =>
		compileWorkflowGraph(graph, catalog(...rest)).issues.map(
			(issue) => issue.code,
		);

	it('accepts a requirement the workspace can satisfy', () => {
		const report = compileWorkflowGraph(approvalGraph(), catalog(true));
		expect(report.issues).toEqual([]);
		expect(report.valid).toBe(true);
		expect(
			report.references.find((entry) => entry.kind === 'approval'),
		).toEqual({ kind: 'approval', id: 'owner', version: '1', available: true });
	});

	it('reports an absent approvals module with a stable code', () => {
		expect(codes(approvalGraph(), false)).toContain(
			'WORKFLOW_APPROVAL_CAPABILITY_UNAVAILABLE',
		);
	});

	it('reports a role the workspace does not define', () => {
		expect(codes(approvalGraph(), true, ['member'])).toContain(
			'WORKFLOW_APPROVAL_ROLE_UNKNOWN',
		);
	});

	it('reports a requirement that names neither a role nor a scope', () => {
		expect(codes(approvalGraph({ decisions: 1 }), true)).toContain(
			'WORKFLOW_APPROVAL_REQUIREMENT_INVALID',
		);
	});

	it('reports a decision count and an expiry outside their bounds', () => {
		expect(
			codes(approvalGraph({ roleKey: 'owner', decisions: 0 }), true),
		).toContain('WORKFLOW_APPROVAL_REQUIREMENT_INVALID');
		expect(
			codes(approvalGraph({ roleKey: 'owner', expiresInDays: 400 }), true),
		).toContain('WORKFLOW_APPROVAL_REQUIREMENT_INVALID');
	});

	it('reports a prompt and a label longer than a request title', () => {
		const over = 'a'.repeat(APPROVAL_LIMITS.title + 1);
		const prompted = approvalGraph();
		(prompted.nodes[1] as unknown as Record<string, unknown>).prompt = over;
		expect(codes(prompted, true)).toContain('WORKFLOW_LIMIT_EXCEEDED');
		/* The label is the title whenever no prompt is set, and it names the step
		   in the summary either way. */
		const labelled = approvalGraph();
		(labelled.nodes[1] as unknown as Record<string, unknown>).label = over;
		expect(codes(labelled, true)).toContain('WORKFLOW_LIMIT_EXCEEDED');
		const exact = approvalGraph();
		(exact.nodes[1] as unknown as Record<string, unknown>).prompt = 'a'.repeat(
			APPROVAL_LIMITS.title,
		);
		expect(codes(exact, true)).toEqual([]);
	});

	it('accepts a scope requirement without a role', () => {
		expect(
			codes(approvalGraph({ scope: 'catalog.products.manage' }), true),
		).toEqual([]);
	});

	it('reports an absent and a null requirement instead of failing on it', () => {
		for (const [label, graph] of [
			['absent', requirementless()],
			['null', requirementless(null)],
		] as const) {
			const report = compileWorkflowGraph(graph, catalog(true));
			expect([label, report.issues.map((issue) => issue.code)]).toEqual([
				label,
				expect.arrayContaining(['WORKFLOW_APPROVAL_REQUIREMENT_INVALID']),
			]);
			expect([label, report.valid]).toEqual([label, false]);
			/* The reference names nothing rather than naming a role read off a
			   requirement that is not there. */
			expect([
				label,
				report.references.find((entry) => entry.kind === 'approval'),
			]).toEqual([
				label,
				{ kind: 'approval', id: '', version: '1', available: true },
			]);
		}
	});

	it('refuses a node that does not declare the fixed approved port', () => {
		const graph = approvalGraph();
		const node = graph.nodes[1] as { outputPorts: unknown };
		node.outputPorts = [
			{ name: 'approved', schemaId: 'schema.data' },
			{ name: 'rejected', schemaId: 'schema.data' },
		];
		expect(
			compileWorkflowGraph(graph, catalog(true)).issues.map((i) => i.code),
		).toContain('WORKFLOW_PORT_CONTRACT_INVALID');
	});
});
