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
import {
	AGENT_DECISIONS_CAPABILITY,
	type AgentDecisionAnswers,
	type AgentDecisionAsk,
	type AgentDecisions,
} from '../src/services/decisions.ts';
import type { WorkflowsService } from '../src/services/workflows-service.ts';
import type { WorkflowsRuntime } from '../src/server/runtime.ts';
import { createWorkflowsTestRuntime } from './support/database.ts';

const tenantId = 'tenant-typed-decision';
const actor = userActor({
	accountId: 'member-typed-decision',
	email: 'member@example.com',
});
const permissions = [
	WORKFLOWS_PERMISSIONS.read,
	WORKFLOWS_PERMISSIONS.manage,
	WORKFLOWS_PERMISSIONS.publish,
	WORKFLOWS_PERMISSIONS.runsRead,
	WORKFLOWS_PERMISSIONS.runsExecute,
];

const schema = {
	type: 'object',
	required: ['summary'],
	properties: { summary: { type: 'string' } },
} as const;

function decisionNode(overrides: Record<string, unknown> = {}) {
	return {
		id: 'decision.triage',
		label: 'Triage',
		type: 'typed-decision',
		inputPorts: [{ name: 'input', schemaId: 'schema.data' }],
		outputPorts: [
			{ name: 'pass', schemaId: 'schema.any' },
			{ name: 'fail', schemaId: 'schema.any' },
			{ name: 'failure', schemaId: 'schema.any' },
		],
		decidingQuestion: 'urgent',
		questions: [
			{
				key: 'urgent',
				kind: 'choice',
				instruction: 'Does this request need attention today?',
				answers: ['yes', 'no'],
			},
		],
		passAnswer: 'yes',
		confidenceThreshold: 0.7,
		statePaths: ['summary'],
		...overrides,
	} as never;
}

function decisionGraph(
	overrides: Record<string, unknown> = {},
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
			decisionNode(overrides),
			{
				id: 'output.done',
				label: 'Output',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.any' }],
				outputPorts: [],
			},
			{
				id: 'output.later',
				label: 'Later',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'schema.any' }],
				outputPorts: [],
			},
		],
		edges: [
			{
				id: 'edge.to-decision',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'decision.triage', port: 'input' },
			},
			{
				id: 'edge.pass',
				source: { nodeId: 'decision.triage', port: 'pass' },
				target: { nodeId: 'output.done', port: 'input' },
			},
			{
				id: 'edge.fail',
				source: { nodeId: 'decision.triage', port: 'fail' },
				target: { nodeId: 'output.later', port: 'input' },
			},
		],
		schemas: { 'schema.data': schema, 'schema.any': { type: 'object' } },
		layout: {
			'input.start': { x: 0, y: 0 },
			'decision.triage': { x: 200, y: 0 },
			'output.done': { x: 400, y: 0 },
			'output.later': { x: 400, y: 120 },
		},
	};
}

function agentDependencies() {
	return {
		agents: {
			listDefinitions: async () => [],
			getRevision: async () => null,
			enqueueRevision: async () => ({ runId: 'child', created: true }),
			readEvents: async () => [],
			getResult: async () => null,
			requestCancel: async () => true,
		} as unknown as AgentRevisionExecutionCapability,
		actions: {
			listWorkflowActions: async () => [],
			start: async () => ({ actionInvocationId: 'action-1', created: true }),
			getResult: async () => null,
			requestCancel: async (actionInvocationId: string) => ({
				actionInvocationId,
				state: 'acknowledged' as const,
			}),
		} as unknown as AgentActionExecutionCapability,
	};
}

/** A stand-in for agents.core with the same capability contract. */
function fakeDecisions(
	answer: AgentDecisionAnswers | (() => Promise<AgentDecisionAnswers>),
) {
	const asked: AgentDecisionAsk[] = [];
	const capability: AgentDecisions = {
		available: async () => true,
		ask: async (request) => {
			asked.push(request);
			return typeof answer === 'function' ? answer() : answer;
		},
	};
	return { capability, asked };
}

function choice(value: string, confidence: number): AgentDecisionAnswers {
	return {
		answers: {
			urgent: {
				type: 'choice',
				choice: value,
				probabilities: { [value]: confidence },
				confidence,
			},
		},
		usage: { inputTokens: 120, outputTokens: 0 },
		connection: { id: 'provider.decisions', key: 'decisions' },
	};
}

function registry(decisions?: AgentDecisions): PlatformCapabilityRegistry {
	const value = createPlatformCapabilityRegistry();
	const fake = agentDependencies();
	value.register(AGENT_RUN_EXECUTION_CAPABILITY, fake.agents);
	value.register(AGENT_ACTION_EXECUTION_CAPABILITY, fake.actions);
	if (decisions) value.register(AGENT_DECISIONS_CAPABILITY, decisions);
	return value;
}

const runtimes: WorkflowsRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

function trackedRuntime(capabilities: PlatformCapabilityRegistry) {
	const runtime = createWorkflowsTestRuntime({
		capabilities,
		roles: async () => ['owner', 'member'],
		payloadKey: Buffer.alloc(32, 9),
		cursorKey: Buffer.alloc(32, 10),
		worker: { pollMs: 100, leaseMs: 5_000 },
	});
	runtimes.push(runtime);
	return runtime;
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

async function publish(
	service: WorkflowsService,
	key: string,
	graph: WorkflowGraphV1,
): Promise<string> {
	const created = await service.create(
		tenantId,
		{ key, name: 'Triage', description: '' },
		actor,
	);
	await service.update(
		tenantId,
		{
			workflowId: created.definition.id,
			expectedRevision: 1,
			name: 'Triage',
			description: '',
			graph,
		},
		actor,
	);
	await service.publish(tenantId, created.definition.id, 2, actor, permissions);
	return created.definition.id;
}

async function runOnce(
	decisions: AgentDecisions | undefined,
	key: string,
): Promise<{
	readonly service: WorkflowsService;
	readonly runId: string;
}> {
	const runtime = trackedRuntime(registry(decisions));
	const service = await runtime.service();
	await publish(service, key, decisionGraph());
	runtime.start();
	const accepted = await service.enqueue(
		{
			workflowKey: key,
			input: { summary: 'Roof is leaking' },
			idempotencyKey: `typed-decision-${key}-1`,
		},
		{
			tenantId,
			actor,
			origin: { kind: 'manual' } as const,
			permissionSnapshot: permissions,
		},
	);
	await waitFor(async () => {
		const run = await service.getRunDetail(tenantId, accepted.runId);
		return ['succeeded', 'failed', 'refused'].includes(run.run.status);
	});
	return { service, runId: accepted.runId };
}

describe('WORKFLOWS-TYPED-DECISION-PASS', () => {
	it('takes the pass port and records the answer with its confidence', async () => {
		const decisions = fakeDecisions(choice('yes', 0.91));

		const { service, runId } = await runOnce(decisions.capability, 'pass');

		const run = await service.getRunDetail(tenantId, runId);
		expect(run.run.status).toBe('succeeded');
		const node = run.nodes.find((entry) => entry.nodeId === 'decision.triage');
		expect(node?.selectedOutcomePort).toBe('pass');
		/* The scenario's promise: the attempt carries the answer, its
		   confidence, the threshold and the connection that answered, and never
		   the question state. */
		const evidence = JSON.stringify(
			run.edges.filter((edge) => edge.sourceNodeId === 'decision.triage'),
		);
		expect(evidence).toContain('"answer":"yes"');
		expect(evidence).toContain('"confidence":0.91');
		expect(evidence).toContain('"threshold":0.7');
		expect(evidence).toContain('"connection":"decisions"');
		expect(evidence).not.toContain('Roof is leaking');
		/* The state names only the paths the node pinned. */
		expect(decisions.asked).toHaveLength(1);
		expect(decisions.asked[0]?.state).toBe('summary: Roof is leaking');
		expect(decisions.asked[0]?.caller.moduleId).toBe('workflows.core');
		expect(Object.keys(decisions.asked[0]?.questions ?? {})).toEqual([
			'urgent',
		]);
	});
});

describe('WORKFLOWS-TYPED-DECISION-LOW', () => {
	it('takes the fail port with the reason when confidence is below the threshold', async () => {
		const decisions = fakeDecisions(choice('yes', 0.42));

		const { service, runId } = await runOnce(decisions.capability, 'low');

		const run = await service.getRunDetail(tenantId, runId);
		/* A technically successful attempt: the run continues where the graph
		   routes the fail port rather than failing. */
		expect(run.run.status).toBe('succeeded');
		const node = run.nodes.find((entry) => entry.nodeId === 'decision.triage');
		expect(node?.selectedOutcomePort).toBe('fail');
		expect(node?.attempts.at(-1)?.status).toBe('succeeded');
	});
});

describe('WORKFLOWS-TYPED-DECISION-UNAVAILABLE', () => {
	it('fails the attempt instead of taking a port when nothing can answer', async () => {
		const { service, runId } = await runOnce(undefined, 'absent');

		const run = await service.getRunDetail(tenantId, runId);
		expect(run.run.status).toBe('refused');
		const node = run.nodes.find((entry) => entry.nodeId === 'decision.triage');
		expect(node?.selectedOutcomePort).not.toBe('fail');
		expect(JSON.stringify(run.nodes)).toContain(
			'WORKFLOW_DECISION_CAPABILITY_UNAVAILABLE',
		);
	});

	it('fails the attempt when the workspace has typed decisions off', async () => {
		const refusing: AgentDecisions = {
			available: async () => false,
			ask: async () => {
				throw Object.assign(new Error('off'), {
					code: 'TYPED_DECISIONS_DISABLED',
				});
			},
		};

		const { service, runId } = await runOnce(refusing, 'disabled');

		const run = await service.getRunDetail(tenantId, runId);
		expect(run.run.status).toBe('failed');
		expect(JSON.stringify(run.nodes)).toContain('TYPED_DECISIONS_DISABLED');
	});
});

describe('WORKFLOWS-TYPED-DECISION-PUBLISH', () => {
	it('refuses a node whose pass answer no question declares', () => {
		const report = compileWorkflowGraph(decisionGraph({ passAnswer: 'maybe' }));

		expect(report.valid).toBe(false);
		expect(report.issues.map((entry) => entry.code)).toContain(
			'WORKFLOW_DECISION_NODE_INVALID',
		);
	});

	it('refuses a threshold outside 0 to 1 and a missing deciding question', () => {
		expect(
			compileWorkflowGraph(decisionGraph({ confidenceThreshold: 1.5 })).valid,
		).toBe(false);
		expect(
			compileWorkflowGraph(decisionGraph({ decidingQuestion: 'absent' })).valid,
		).toBe(false);
	});

	/* A yes-no answer carries no confidence, so it can never clear a threshold. */
	it('refuses a yes-no question as the deciding one', () => {
		const report = compileWorkflowGraph(
			decisionGraph({
				decidingQuestion: 'urgent',
				questions: [
					{ key: 'urgent', kind: 'noul', instruction: 'Is it urgent?' },
				],
			}),
		);

		expect(report.valid).toBe(false);
	});

	it('refuses more questions than the capability accepts', () => {
		const report = compileWorkflowGraph(
			decisionGraph({
				questions: Array.from({ length: 9 }, (_, index) => ({
					key: `question${index}`,
					kind: 'choice',
					instruction: 'Which one?',
					answers: ['yes', 'no'],
				})),
				decidingQuestion: 'question0',
			}),
		);

		expect(report.valid).toBe(false);
	});

	it('accepts the node the editor produces once it is filled in', () => {
		const report = compileWorkflowGraph(decisionGraph());
		expect(report.issues, JSON.stringify(report.issues)).toEqual([]);
		expect(report.valid).toBe(true);
	});
});

describe('WORKFLOWS-TYPED-DECISION-NO-TOOLS', () => {
	it('carries no agent and no tool grant to pin', () => {
		const node = decisionGraph().nodes[1] as unknown as Record<string, unknown>;

		expect(node.agent).toBeUndefined();
		expect(node.toolGrants).toBeUndefined();
		/* The published references of the graph name no agent for this node. */
		const report = compileWorkflowGraph(decisionGraph());
		expect(report.references.some((entry) => entry.kind === 'agent')).toBe(
			false,
		);
	});
});
