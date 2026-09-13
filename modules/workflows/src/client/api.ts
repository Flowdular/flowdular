import { t } from '@flowdular/client/i18n';
import type {
	CreateWorkflowDefinitionInput,
	JsonValue,
	UpdateWorkflowDraftInput,
	WorkflowCancellationResult,
	WorkflowDefinition,
	WorkflowDefinitionDetail,
	WorkflowDefinitionListQuery,
	WorkflowDryRunResponseV1,
	WorkflowEnqueueRequest,
	WorkflowListQuery,
	WorkflowRunAccepted,
	WorkflowRunDetail,
	WorkflowRunEventV1,
	WorkflowRunListQuery,
	WorkflowRunSummary,
	WorkflowSimulationRequest,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('workflows.error.request'));
	}
	return value;
}

export interface WorkflowAgentCatalogItem {
	readonly agentId: string;
	readonly name: string;
	readonly description: string;
	readonly revision: number;
	readonly allowedTools: readonly string[];
}

export interface WorkflowActionCatalogItem {
	readonly actionId: string;
	readonly label: string;
	readonly description: string;
	readonly contractVersion: number;
	readonly risk: 'read' | 'workspace-write';
	readonly requiredPermissions: readonly string[];
}

function mutationHeaders(csrfToken: string): Record<string, string> {
	return {
		accept: 'application/json',
		'content-type': 'application/json',
		'x-csrf-token': csrfToken,
	};
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	return payload<T>(
		await fetch(path, {
			method: 'POST',
			headers: mutationHeaders(csrfToken),
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
}

/** One page of a server-sorted list; `nextCursor` is null on the last page. */
export interface WorkflowListPage<T> {
	readonly items: readonly T[];
	readonly page: {
		readonly nextCursor: string | null;
		readonly limit: number;
	};
}

function listParams(
	query: WorkflowListQuery<string>,
	filters: Readonly<Record<string, string | undefined>>,
): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value) params.set(key, value);
	}
	if (query.sort) params.set('sort', query.sort);
	if (query.direction) params.set('direction', query.direction);
	if (query.limit !== undefined) params.set('limit', String(query.limit));
	if (query.cursor) params.set('cursor', query.cursor);
	const text = params.toString();
	return text ? `?${text}` : '';
}

async function loadPage<T>(path: string): Promise<WorkflowListPage<T>> {
	const response = await fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<WorkflowListPage<T>>(response);
}

export function loadWorkflowDefinitions(
	query: WorkflowDefinitionListQuery = {},
): Promise<WorkflowListPage<WorkflowDefinition>> {
	return loadPage(
		'/api/workflows' +
			listParams(query, { status: query.status, q: query.search }),
	);
}

export async function createWorkflowDefinition(
	input: CreateWorkflowDefinitionInput,
	csrfToken: string,
): Promise<WorkflowDefinition> {
	return (
		await post<{ readonly definition: WorkflowDefinition }>(
			'/api/workflows',
			input,
			csrfToken,
		)
	).definition;
}

export async function loadWorkflowDetail(
	workflowId: string,
): Promise<WorkflowDefinitionDetail> {
	const response = await fetch(
		`/api/workflows/detail?id=${encodeURIComponent(workflowId)}`,
		{ headers: { accept: 'application/json' }, credentials: 'same-origin' },
	);
	return (
		await payload<{ readonly detail: WorkflowDefinitionDetail }>(response)
	).detail;
}

export async function updateWorkflowDraft(
	input: UpdateWorkflowDraftInput,
	csrfToken: string,
): Promise<WorkflowDefinitionDetail> {
	return (
		await post<{ readonly detail: WorkflowDefinitionDetail }>(
			'/api/workflows/update',
			input,
			csrfToken,
		)
	).detail;
}

export async function validateWorkflowGraph(
	graph: UpdateWorkflowDraftInput['graph'],
	csrfToken: string,
): Promise<WorkflowDryRunResponseV1> {
	return (
		await post<{ readonly report: WorkflowDryRunResponseV1 }>(
			'/api/workflows/validate',
			{ graph },
			csrfToken,
		)
	).report;
}

export async function publishWorkflow(
	workflowId: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<WorkflowDefinitionDetail> {
	return (
		await post<{ readonly detail: WorkflowDefinitionDetail }>(
			'/api/workflows/publish',
			{ workflowId, expectedRevision },
			csrfToken,
		)
	).detail;
}

export async function archiveWorkflow(
	workflowId: string,
	csrfToken: string,
): Promise<WorkflowDefinition> {
	return (
		await post<{ readonly definition: WorkflowDefinition }>(
			'/api/workflows/archive',
			{ workflowId },
			csrfToken,
		)
	).definition;
}

export async function deleteWorkflow(
	workflowId: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: true }>(
		'/api/workflows/delete',
		{ workflowId },
		csrfToken,
	);
}

export async function loadWorkflowCatalog(): Promise<{
	readonly agents: readonly WorkflowAgentCatalogItem[];
	readonly actions: readonly WorkflowActionCatalogItem[];
}> {
	const [agentResponse, actionResponse] = await Promise.all([
		fetch('/api/workflow-catalog/agents', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
		fetch('/api/workflow-catalog/actions', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	]);
	const agents = await payload<{
		readonly agents: readonly WorkflowAgentCatalogItem[];
	}>(agentResponse);
	const actions = await payload<{
		readonly actions: readonly WorkflowActionCatalogItem[];
	}>(actionResponse);
	return { agents: agents.agents, actions: actions.actions };
}

export function loadWorkflowRuns(
	query: WorkflowRunListQuery = {},
): Promise<WorkflowListPage<WorkflowRunSummary>> {
	return loadPage(
		'/api/workflow-runs' +
			listParams(query, {
				workflowId: query.workflowId,
				mode: query.mode,
				status: query.status,
				actorKind: query.actorKind,
				originKind: query.originKind,
				q: query.search,
			}),
	);
}

export async function loadWorkflowRunDetail(
	runId: string,
): Promise<WorkflowRunDetail> {
	const response = await fetch(
		`/api/workflow-runs/detail?id=${encodeURIComponent(runId)}`,
		{ headers: { accept: 'application/json' }, credentials: 'same-origin' },
	);
	return payload<WorkflowRunDetail>(response);
}

export async function simulateWorkflow(
	request: WorkflowSimulationRequest,
	csrfToken: string,
): Promise<WorkflowRunDetail> {
	return (
		await post<{ readonly run: WorkflowRunDetail }>(
			'/api/workflow-runs/simulate',
			request,
			csrfToken,
		)
	).run;
}

export async function enqueueWorkflow(
	request: WorkflowEnqueueRequest,
	csrfToken: string,
): Promise<WorkflowRunAccepted> {
	return (
		await post<{ readonly accepted: WorkflowRunAccepted }>(
			'/api/workflow-runs',
			request,
			csrfToken,
		)
	).accepted;
}

export async function cancelWorkflowRun(
	runId: string,
	csrfToken: string,
): Promise<WorkflowCancellationResult> {
	return post<WorkflowCancellationResult>(
		'/api/workflow-runs/cancel',
		{ runId },
		csrfToken,
	);
}

export async function retryWorkflowRun(
	runId: string,
	csrfToken: string,
): Promise<WorkflowRunAccepted> {
	return post<WorkflowRunAccepted>(
		'/api/workflow-runs/retry',
		{ runId },
		csrfToken,
	);
}

export function observeWorkflowRun(
	runId: string,
	afterSequence: number,
	onEvent: (event: WorkflowRunEventV1) => void,
	onComplete: () => void,
): () => void {
	const source = new EventSource(
		`/api/workflow-runs/events?runId=${encodeURIComponent(runId)}&afterSequence=${afterSequence}`,
		{ withCredentials: true },
	);
	source.onmessage = (message) => {
		const event = JSON.parse(message.data) as WorkflowRunEventV1;
		onEvent(event);
		if (
			['run.succeeded', 'run.failed', 'run.refused', 'run.cancelled'].includes(
				event.type,
			)
		) {
			source.close();
			onComplete();
		}
	};
	source.addEventListener('workflow.stream-complete', () => {
		source.close();
		onComplete();
	});
	return () => source.close();
}

export function parseJsonInput(value: string): JsonValue {
	return JSON.parse(value) as JsonValue;
}
