import type {
	JsonValue,
	WorkflowEdgeTransfer,
	WorkflowNodeV1,
	WorkflowRunDetail,
	WorkflowSimulationFixture,
	WorkflowUsageRollupV1,
	WorkflowCostRollupV1,
} from '../domain/types.ts';
import {
	applyWorkflowMappings,
	evaluateGate,
	validateJsonSchema,
	jsonByteSize,
} from '../domain/graph.ts';
import { safePayloadEvidence } from './payload-codec.ts';
import type { WorkflowRunRecord, WorkflowsRepository } from './repository.ts';

const NOT_APPLICABLE_USAGE: WorkflowUsageRollupV1 = {
	version: 1,
	state: 'not-applicable',
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	includedChildRunIds: [],
	pricedChildRuns: 0,
	unpricedChildRuns: 0,
	actionInvocations: 0,
	unpricedActions: 0,
};

const NOT_APPLICABLE_COST: WorkflowCostRollupV1 = {
	version: 1,
	state: 'not-applicable',
	currency: 'USD',
	amountMicros: 0,
	pricingSnapshotIds: [],
	unpricedChildRuns: 0,
	unpricedActions: 0,
};

function schemaForInput(node: WorkflowNodeV1): string {
	if (node.type === 'input')
		return node.outputPorts[0]?.schemaId ?? 'workflow.input';
	return node.inputPorts[0]?.schemaId ?? 'workflow.input';
}

function schemaForOutput(node: WorkflowNodeV1, port: string): string {
	if (node.type === 'output')
		return node.inputPorts[0]?.schemaId ?? 'workflow.output';
	return (
		node.outputPorts.find((entry) => entry.name === port)?.schemaId ??
		'workflow.output'
	);
}

export async function simulateWorkflow(
	repository: WorkflowsRepository,
	run: WorkflowRunRecord,
	input: JsonValue,
	fixtures: readonly WorkflowSimulationFixture[],
): Promise<WorkflowRunDetail> {
	const fixtureByNode = new Map(
		fixtures.map((fixture) => [fixture.nodeId, fixture]),
	);
	if (fixtureByNode.size !== fixtures.length)
		throw new Error('WORKFLOW_FIXTURE_DUPLICATE');
	const nodeById = new Map(run.graph.nodes.map((node) => [node.id, node]));
	const outputs = new Map<string, JsonValue>();
	const edgeState = new Map<string, WorkflowEdgeTransfer['state']>();
	let virtualOffsetMs = 0;
	let finalOutput: JsonValue | undefined;
	let terminalFailure: string | null = null;
	let recordedAt = Date.now();

	for (const nodeId of run.compiledOrder) {
		const node = nodeById.get(nodeId);
		if (!node) throw new Error('WORKFLOW_RECOVERY_INCONSISTENT');
		const incoming = run.graph.edges
			.filter((edge) => edge.target.nodeId === nodeId)
			.sort((left, right) => left.id.localeCompare(right.id));
		const emittedInputs = incoming
			.filter((edge) => edgeState.get(edge.id) === 'emitted')
			.map((edge) => outputs.get(`${edge.source.nodeId}:${edge.source.port}`))
			.filter((value): value is JsonValue => value !== undefined);
		if (node.type !== 'input' && emittedInputs.length === 0) {
			await repository.markNodeSkipped(
				run.tenantId,
				run.id,
				node.id,
				'upstream-branch-closed',
				recordedAt,
				run.actor,
				run.origin,
				virtualOffsetMs,
			);
			for (const edge of run.graph.edges.filter(
				(entry) => entry.source.nodeId === node.id,
			)) {
				const evidence = safePayloadEvidence(
					undefined,
					schemaForOutput(node, edge.source.port),
				);
				await repository.settleEdge({
					tenantId: run.tenantId,
					runId: run.id,
					transfer: {
						edgeId: edge.id,
						sourceNodeId: node.id,
						sourcePort: edge.source.port,
						sourceAttempt: null,
						targetNodeId: edge.target.nodeId,
						targetPort: edge.target.port,
						state: 'skipped',
						reason: 'source-skipped',
						evidence,
						settledAt: recordedAt,
					},
					virtualOffsetMs,
				});
				edgeState.set(edge.id, 'skipped');
			}
			continue;
		}

		const baseInput: JsonValue =
			node.type === 'input'
				? input
				: node.type === 'merge'
					? emittedInputs
					: (emittedInputs[0] ?? null);
		let nodeInput = baseInput;
		let mappingError: unknown;
		try {
			nodeInput = applyWorkflowMappings(
				baseInput,
				node.mappings ?? [],
				outputs,
			);
		} catch (error) {
			mappingError = error;
		}
		const inputSchemaId = schemaForInput(node);
		const inputEvidence = safePayloadEvidence(nodeInput, inputSchemaId, {
			schema: run.graph.schemas[inputSchemaId] ?? {},
			permissionSnapshot: run.permissionSnapshot,
		});
		const priorState = (
			await repository.readNodeStates(run.tenantId, run.id)
		).find((entry) => entry.nodeId === node.id);
		const attempt = (priorState?.latestAttempt ?? 0) + 1;
		const semanticGroup = `${run.id}:${node.id}`;
		await repository.startAttempt(
			{
				tenantId: run.tenantId,
				runId: run.id,
				nodeId: node.id,
				nodeType: node.type,
				attempt,
				semanticGroup,
				sideEffectIdempotencyKey: semanticGroup,
				input: nodeInput,
				inputEvidence,
				schemaId: inputSchemaId,
				recordedAt,
				virtualOffsetMs,
			},
			run.actor,
			run.origin,
		);

		const fixture = fixtureByNode.get(node.id);
		const duration = Math.max(
			0,
			Math.min(3_600_000, Math.trunc(fixture?.simulatedDurationMs ?? 0)),
		);
		virtualOffsetMs += duration;
		recordedAt = Date.now();
		let outcomePort = '';
		let output: JsonValue | undefined;
		let status: 'succeeded' | 'failed' | 'refused' = 'succeeded';
		let failureCode: string | null = null;

		try {
			if (mappingError) throw mappingError;
			if (jsonByteSize(nodeInput) > 64 * 1024)
				throw new Error('WORKFLOW_INPUT_LIMIT_EXCEEDED');
			const schemaErrors =
				node.type === 'merge'
					? emittedInputs.flatMap((value) =>
							validateJsonSchema(value, run.graph.schemas[inputSchemaId] ?? {}),
						)
					: validateJsonSchema(
							nodeInput,
							run.graph.schemas[inputSchemaId] ?? {},
						);
			if (schemaErrors.length > 0) throw new Error('WORKFLOW_INPUT_INVALID');
			switch (node.type) {
				case 'input':
					outcomePort = 'data';
					output = nodeInput;
					break;
				case 'gate':
					outcomePort = evaluateGate(node.expression, nodeInput)
						? 'pass'
						: 'fail';
					output = nodeInput;
					break;
				case 'validator': {
					const errors = validateJsonSchema(
						nodeInput,
						run.graph.schemas[node.schemaId] ?? {},
					);
					outcomePort = errors.length === 0 ? 'pass' : 'fail';
					output =
						errors.length === 0
							? nodeInput
							: { errors: errors as unknown as JsonValue };
					break;
				}
				case 'merge':
					outcomePort = 'data';
					output = nodeInput;
					break;
				/* A simulation asks nobody, so the person is assumed to agree. The
				   node still has to be rehearsable, and a fixture that wanted a
				   rejection would be a second outcome port this node does not have. */
				case 'human-approval':
					outcomePort = 'approved';
					output = nodeInput;
					break;
				case 'output':
					outcomePort = 'complete';
					output = nodeInput;
					break;
				case 'agent':
				case 'action':
				case 'agent-decision':
					if (!fixture) throw new Error('WORKFLOW_FIXTURE_MISSING');
					if (fixture.failureCode) {
						status = 'failed';
						failureCode = fixture.failureCode;
						outcomePort = 'failure';
						output = { code: fixture.failureCode };
					} else {
						outcomePort =
							fixture.outcomePort ??
							(node.type === 'agent-decision' ? 'pass' : 'success');
						output = fixture.output ?? null;
					}
					break;
			}
			if (
				node.type !== 'output' &&
				!node.outputPorts.some((port) => port.name === outcomePort)
			)
				throw new Error('WORKFLOW_OUTPUT_INVALID');
			if (
				output !== undefined &&
				(jsonByteSize(output) > 64 * 1024 ||
					validateJsonSchema(
						output,
						run.graph.schemas[schemaForOutput(node, outcomePort)] ?? {},
					).length)
			)
				throw new Error('WORKFLOW_OUTPUT_INVALID');
			if (node.type === 'output') finalOutput = nodeInput;
		} catch (error) {
			status = 'refused';
			failureCode =
				error instanceof Error ? error.message : 'WORKFLOW_SIMULATION_FAILED';
			outcomePort = node.outputPorts.some((port) => port.name === 'failure')
				? 'failure'
				: '';
			output = undefined;
		}

		const outputSchemaId = schemaForOutput(node, outcomePort);
		const outputEvidence = safePayloadEvidence(output, outputSchemaId, {
			schema: run.graph.schemas[outputSchemaId] ?? {},
			permissionSnapshot: run.permissionSnapshot,
		});
		await repository.settleAttempt(
			{
				tenantId: run.tenantId,
				runId: run.id,
				nodeId: node.id,
				attempt,
				status,
				outcomePort: outcomePort || null,
				...(output === undefined ? {} : { output }),
				outputEvidence,
				schemaId: outputSchemaId,
				failureCode,
				retryClassification: failureCode ? 'permanent' : null,
				selectedBackoffMs: null,
				nextAttemptAt: null,
				recordedAt,
				virtualOffsetMs,
			},
			run.actor,
			run.origin,
		);

		if (
			status === 'refused' ||
			(status === 'failed' &&
				node.failurePolicy?.onExhausted !== 'emit-failure')
		) {
			terminalFailure = failureCode;
			break;
		}
		if (output !== undefined && outcomePort) {
			outputs.set(`${node.id}:${outcomePort}`, output);
		}
		for (const edge of run.graph.edges.filter(
			(entry) => entry.source.nodeId === node.id,
		)) {
			const selected = edge.source.port === outcomePort && output !== undefined;
			const transferEvidence = safePayloadEvidence(
				selected ? output : undefined,
				schemaForOutput(node, edge.source.port),
				{
					schema:
						run.graph.schemas[schemaForOutput(node, edge.source.port)] ?? {},
					permissionSnapshot: run.permissionSnapshot,
				},
			);
			await repository.settleEdge({
				tenantId: run.tenantId,
				runId: run.id,
				transfer: {
					edgeId: edge.id,
					sourceNodeId: node.id,
					sourcePort: edge.source.port,
					sourceAttempt: attempt,
					targetNodeId: edge.target.nodeId,
					targetPort: edge.target.port,
					state: selected ? 'emitted' : 'closed',
					reason: selected ? null : `outcome:${outcomePort || 'none'}`,
					evidence: transferEvidence,
					settledAt: recordedAt,
				},
				...(selected && output !== undefined ? { payload: output } : {}),
				virtualOffsetMs,
			});
			edgeState.set(edge.id, selected ? 'emitted' : 'closed');
		}
	}

	const succeeded = finalOutput !== undefined && terminalFailure === null;
	const finalEvidence = safePayloadEvidence(finalOutput, 'workflow.output');
	await repository.settleRun(
		run.tenantId,
		run.id,
		succeeded ? 'succeeded' : 'failed',
		succeeded ? null : (terminalFailure ?? 'WORKFLOW_OUTPUT_MISSING'),
		finalOutput,
		finalEvidence,
		NOT_APPLICABLE_USAGE,
		NOT_APPLICABLE_COST,
		Date.now(),
		virtualOffsetMs,
	);
	return (await repository.runDetail(run.tenantId, run.id))!;
}
