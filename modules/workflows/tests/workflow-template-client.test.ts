import { describe, expect, it } from 'vitest';
import type { WorkflowRunDetail } from '../src/domain/types.ts';
import type { WorkflowActionCatalogItem } from '../src/client/api.ts';
import {
	addWorkflowActionTemplate,
	addWorkflowNode,
	bindWorkflowAction,
	emptyWorkflowGraph,
	namedWorkflowActions,
	removeWorkflowNode,
} from '../src/client/canvas-model.ts';
import { addConnectedActionTemplate } from '../src/client/connected-node.ts';
import { validateMappingInput } from '../src/client/mapping-model.ts';
import { pointerCatalog } from '../src/client/pointer-model.ts';
import { workflowNodeTrail } from '../src/client/run-trail.ts';

const action: WorkflowActionCatalogItem = {
	actionId: 'inventory.reserve',
	label: 'inventory.reserve',
	description: 'Reserve items in inventory.',
	contractVersion: 3,
	risk: 'workspace-write',
	requiredPermissions: ['inventory.reserve'],
	inputSchema: {
		type: 'object',
		required: ['sku'],
		properties: { sku: { type: 'string' } },
		additionalProperties: false,
	},
	outputSchema: {
		type: 'object',
		required: ['reservationId'],
		properties: { reservationId: { type: 'string' } },
		additionalProperties: false,
	},
	idempotency: 'required',
	idempotencyProtection: 'target-ledger',
	timeoutMs: 10_000,
	cancellation: 'cooperative',
	descriptorDigest: `sha256:${'a'.repeat(64)}`,
	workflowTemplate: {
		label: 'Reserve inventory',
		description: 'Reserves stock for an order.',
		effect: 'connector-egress',
	},
};

describe('named workflow action templates', () => {
	it('keeps generic actions out of the named palette', () => {
		const { workflowTemplate: _template, ...genericContract } = action;
		const generic = {
			...genericContract,
			actionId: 'inventory.lookup',
		};
		expect(namedWorkflowActions([action, generic])).toEqual([action]);
	});

	it('pins the exact action reference and copies its editable schemas into an ordinary action node', () => {
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), action);
		const node = added.graph.nodes.find((entry) => entry.id === added.nodeId);
		expect(node).toMatchObject({
			type: 'action',
			label: 'Reserve inventory',
			action: {
				actionId: 'inventory.reserve',
				contractVersion: 3,
				descriptorDigest: action.descriptorDigest,
			},
			inputPorts: [{ name: 'input', schemaId: 'action.n1.input' }],
			outputPorts: [
				{ name: 'success', schemaId: 'action.n1.success' },
				{ name: 'failure', schemaId: 'workflow.error' },
			],
		});
		expect(added.graph.schemas['action.n1.input']).toEqual(action.inputSchema);
		expect(added.graph.schemas['action.n1.success']).toEqual(
			action.outputSchema,
		);
		expect(
			removeWorkflowNode(added.graph, added.nodeId).schemas,
		).not.toHaveProperty('action.n1.input');
	});

	it('connects a template with an equivalent source schema and leaves a mismatched graph alone', () => {
		const source = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
		const request = {
			position: { x: 420, y: 80 },
			source: { nodeId: source.nodeId, port: 'data' },
		};
		expect(
			addConnectedActionTemplate(source.graph, action, request),
		).toBeNull();
		const matching = {
			...source.graph,
			schemas: { ...source.graph.schemas, 'workflow.data': action.inputSchema },
		};
		const added = addConnectedActionTemplate(matching, action, request);
		expect(added?.graph.edges).toHaveLength(1);
		expect(added?.graph.nodes.at(-1)).toMatchObject({
			type: 'action',
			inputPorts: [{ name: 'input', schemaId: 'workflow.data' }],
		});
		expect(added?.graph.schemas).not.toHaveProperty('action.n1.input');
	});

	it('clears old mappings when an editor switches executable contracts', () => {
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), action);
		const graph = {
			...added.graph,
			nodes: added.graph.nodes.map((node) =>
				node.id === added.nodeId
					? {
							...node,
							mappings: [
								{
									targetPointer: '/sku',
									binding: { kind: 'literal' as const, value: 'old' },
								},
							],
						}
					: node,
			),
		};
		const next = bindWorkflowAction(graph, added.nodeId, {
			...action,
			actionId: 'inventory.reserve-v4',
			contractVersion: 4,
			descriptorDigest: `sha256:${'b'.repeat(64)}`,
		});
		expect(next.nodes.find((node) => node.id === added.nodeId)).toMatchObject({
			action: { actionId: 'inventory.reserve-v4', contractVersion: 4 },
			mappings: [],
		});
		const rebound = bindWorkflowAction(next, added.nodeId, {
			...action,
			actionId: 'inventory.reserve-v4',
			contractVersion: 4,
			descriptorDigest: `sha256:${'b'.repeat(64)}`,
		});
		expect(Object.keys(rebound.schemas)).toEqual(Object.keys(next.schemas));
		const drifted = bindWorkflowAction(graph, added.nodeId, {
			...action,
			descriptorDigest: `sha256:${'c'.repeat(64)}`,
		});
		expect(
			drifted.nodes.find((node) => node.id === added.nodeId),
		).toMatchObject({
			mappings: [],
		});
	});

	it('does not offer or accept raw secret input fields', () => {
		const secretSchema = {
			type: 'object',
			properties: {
				credential: { type: 'string', writeOnly: true },
				apiKey: { type: 'string', 'x-flowdular-secret': true },
				legacyToken: { type: 'string', 'x-coreloom-secret': true },
				reference: { type: 'string' },
			},
			additionalProperties: false,
		} as const;
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), {
			...action,
			inputSchema: secretSchema,
		});
		expect(
			pointerCatalog(secretSchema).entries.map((entry) => entry.pointer),
		).toEqual(['', '/reference']);
		const mapping = (targetPointer: string) => ({
			targetPointer,
			binding: { kind: 'literal' as const, value: 'value' },
		});
		expect(
			validateMappingInput(mapping('/credential'), added.graph, added.nodeId),
		).toBe(false);
		expect(
			validateMappingInput(mapping('/apiKey'), added.graph, added.nodeId),
		).toBe(false);
		expect(
			validateMappingInput(mapping('/legacyToken'), added.graph, added.nodeId),
		).toBe(false);
		expect(validateMappingInput(mapping(''), added.graph, added.nodeId)).toBe(
			false,
		);
		expect(
			validateMappingInput(mapping('/reference'), added.graph, added.nodeId),
		).toBe(true);
	});

	it.each([
		{ additionalProperties: { type: 'string', 'x-flowdular-secret': true } },
		{
			patternProperties: {
				'^credential_': { type: 'string', 'x-flowdular-secret': true },
			},
		},
	])('does not allow editing a dynamic secret field', (dynamicFields) => {
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), {
			...action,
			inputSchema: { type: 'object', ...dynamicFields },
		});
		expect(
			validateMappingInput(
				{
					targetPointer: '/credential_dynamic',
					binding: { kind: 'literal', value: 'token' },
				},
				added.graph,
				added.nodeId,
			),
		).toBe(false);
		expect(
			validateMappingInput(
				{
					targetPointer: '',
					binding: { kind: 'literal', value: { credential_dynamic: 'token' } },
				},
				added.graph,
				added.nodeId,
			),
		).toBe(false);
	});

	it('rejects a declared input field overlapped by a secret pattern', () => {
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), {
			...action,
			inputSchema: {
				type: 'object',
				properties: { credential: { type: 'string' } },
				patternProperties: {
					'^credential$': { type: 'string', 'x-flowdular-secret': true },
				},
			},
		});
		expect(
			validateMappingInput(
				{
					targetPointer: '/credential',
					binding: { kind: 'literal', value: 'token' },
				},
				added.graph,
				added.nodeId,
			),
		).toBe(false);
	});
});

describe('run evidence for a named action', () => {
	it('groups every attempt with its persisted traversed edges and pinned action', () => {
		const added = addWorkflowActionTemplate(emptyWorkflowGraph(), action);
		const redacted = {
			version: 1 as const,
			state: 'redacted' as const,
			schemaId: 'action.n1.input',
			hash: 'input-hash',
			originalByteSize: 80,
			reason: 'secret' as const,
		};
		const expired = {
			version: 1 as const,
			state: 'expired' as const,
			schemaId: 'action.n1.success',
			hash: 'output-hash',
			originalByteSize: 400,
			reason: 'retention' as const,
		};
		const attempt = (number: number) => ({
			nodeId: added.nodeId,
			attempt: number,
			nodeType: 'action' as const,
			status: number === 1 ? ('failed' as const) : ('succeeded' as const),
			outcomePort: number === 1 ? 'failure' : 'success',
			semanticGroup: 'run:node',
			sideEffectIdempotencyKey: 'tenant:run:node',
			input: redacted,
			output: expired,
			childKind: 'action' as const,
			childId: `child-${number}`,
			childObservationDeadlineAt: null,
			failureCode: number === 1 ? 'TEMPORARY_FAILURE' : null,
			retryClassification: number === 1 ? ('retryable' as const) : null,
			selectedBackoffMs: number === 1 ? 100 : null,
			nextAttemptAt: null,
			startedAt: 1_000 + number * 100,
			completedAt: 1_050 + number * 100,
			durationMs: 50,
		});
		const detail: WorkflowRunDetail = {
			run: {
				id: 'run',
				workflowId: 'workflow',
				workflowKey: 'reserve',
				workflowName: 'Reserve',
				workflowRevision: 2,
				graphChecksum: 'checksum',
				mode: 'live',
				status: 'succeeded',
				actor: { kind: 'user', id: 'operator', label: 'Operator' },
				origin: { kind: 'manual' },
				queuedAt: 1_000,
				startedAt: 1_100,
				completedAt: 1_300,
				durationMs: 200,
				completedNodes: 1,
				totalNodes: 1,
				failureCode: null,
				usage: {
					version: 1,
					state: 'not-applicable',
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					includedChildRunIds: [],
					pricedChildRuns: 0,
					unpricedChildRuns: 0,
					actionInvocations: 2,
					unpricedActions: 0,
				},
				cost: {
					version: 1,
					state: 'not-applicable',
					currency: 'USD',
					amountMicros: 0,
					pricingSnapshotIds: [],
					unpricedChildRuns: 0,
					unpricedActions: 0,
				},
			},
			graph: added.graph,
			compiledOrder: [added.nodeId],
			nodes: [
				{
					nodeId: added.nodeId,
					status: 'succeeded',
					latestAttempt: 2,
					selectedOutcomePort: 'success',
					nextAttemptAt: null,
					readyAt: 1_000,
					startedAt: 1_100,
					settledAt: 1_300,
					attempts: [attempt(1), attempt(2)],
				},
			],
			edges: [
				{
					edgeId: 'failure-edge',
					sourceNodeId: added.nodeId,
					sourcePort: 'failure',
					sourceAttempt: 1,
					targetNodeId: 'output.failed',
					targetPort: 'input',
					state: 'closed',
					reason: 'retry',
					evidence: expired,
					settledAt: 1_150,
				},
				{
					edgeId: 'success-edge',
					sourceNodeId: added.nodeId,
					sourcePort: 'success',
					sourceAttempt: 2,
					targetNodeId: 'output.done',
					targetPort: 'input',
					state: 'emitted',
					reason: null,
					evidence: expired,
					settledAt: 1_250,
				},
				{
					edgeId: 'skipped-edge',
					sourceNodeId: added.nodeId,
					sourcePort: 'failure',
					sourceAttempt: null,
					targetNodeId: 'output.skipped',
					targetPort: 'input',
					state: 'skipped',
					reason: 'other branch',
					evidence: expired,
					settledAt: 1_250,
				},
			],
			events: [],
			input: redacted,
			output: expired,
		};
		const trail = workflowNodeTrail(detail, added.nodeId);
		expect(trail?.action).toMatchObject({
			actionId: 'inventory.reserve',
			contractVersion: 3,
		});
		expect(
			trail?.attempts.map((entry) => ({
				attempt: entry.attempt.attempt,
				status: entry.attempt.status,
				failureCode: entry.attempt.failureCode,
				edges: entry.edges.map((edge) => [edge.sourcePort, edge.state]),
			})),
		).toEqual([
			{
				attempt: 1,
				status: 'failed',
				failureCode: 'TEMPORARY_FAILURE',
				edges: [['failure', 'closed']],
			},
			{
				attempt: 2,
				status: 'succeeded',
				failureCode: null,
				edges: [['success', 'emitted']],
			},
		]);
		expect(trail?.attempts[0]?.attempt.input).toMatchObject({
			state: 'redacted',
			hash: 'input-hash',
		});
		expect(trail?.attempts[1]?.attempt.output).toMatchObject({
			state: 'expired',
			hash: 'output-hash',
		});
		expect(trail?.otherEdges.map((edge) => edge.edgeId)).toEqual([
			'skipped-edge',
		]);
		expect(workflowNodeTrail(detail, 'missing')).toBeNull();
	});
});
