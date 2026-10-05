import type {
	WorkflowEdgeTransfer,
	WorkflowNodeAttempt,
	WorkflowNodeExecution,
	WorkflowRunDetail,
} from '../domain/types.ts';

export interface WorkflowNodeTrail {
	readonly execution: WorkflowNodeExecution;
	readonly action: {
		readonly actionId: string;
		readonly contractVersion: number;
	} | null;
	readonly attempts: readonly {
		readonly attempt: WorkflowNodeAttempt;
		readonly edges: readonly WorkflowEdgeTransfer[];
	}[];
	readonly otherEdges: readonly WorkflowEdgeTransfer[];
}

/** A selected node's immutable attempts and the edges each attempt settled. */
export function workflowNodeTrail(
	detail: WorkflowRunDetail,
	nodeId: string,
): WorkflowNodeTrail | null {
	const execution = detail.nodes.find((node) => node.nodeId === nodeId);
	if (!execution) return null;
	const graphNode = detail.graph.nodes.find((node) => node.id === nodeId);
	const byAttempt = new Map<number, WorkflowEdgeTransfer[]>();
	const otherEdges: WorkflowEdgeTransfer[] = [];
	for (const edge of detail.edges) {
		if (edge.sourceNodeId !== nodeId) continue;
		if (edge.sourceAttempt === null) {
			otherEdges.push(edge);
			continue;
		}
		const group = byAttempt.get(edge.sourceAttempt) ?? [];
		group.push(edge);
		byAttempt.set(edge.sourceAttempt, group);
	}
	const attempts = execution.attempts.map((attempt) => ({
		attempt,
		edges: byAttempt.get(attempt.attempt) ?? [],
	}));
	const known = new Set(execution.attempts.map((attempt) => attempt.attempt));
	for (const [number, edges] of byAttempt) {
		if (!known.has(number)) otherEdges.push(...edges);
	}
	return {
		execution,
		action: graphNode?.type === 'action' ? graphNode.action : null,
		attempts,
		otherEdges,
	};
}
