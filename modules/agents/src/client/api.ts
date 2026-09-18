import type { AgentExecutionEvent } from '@flowdular/harness';
import { t } from '@flowdular/client/i18n';
import {
	appendRunTimeline,
	timelineSequence,
	type RunTimelineEntry,
} from '../domain/run-timeline.ts';
import type {
	AgentDefinition,
	AgentListSort,
	AgentProviderConnection,
	AgentRun,
	AgentRunTimeline,
	AgentProcedure,
	AgentUsageSummary,
	AgentWorkerStatus,
	AssistantConversation,
	AssistantReadiness,
	AssistantThread,
	CreateAgentProviderInput,
	CreateAgentInput,
	CreateAgentProcedureInput,
	EnqueueAgentRunInput,
	ListDirection,
	ModuleAgentView,
	TenantAgentView,
	UpdateAgentProviderInput,
	UpdateAgentInput,
	UpdateModuleAgentBindingInput,
	UpdateAgentProcedureInput,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('agents.common.requestFailed'));
	}
	return value;
}

function mutationHeaders(csrfToken: string): HeadersInit {
	return {
		'content-type': 'application/json',
		'x-csrf-token': csrfToken,
	};
}

export interface PageResult<Item> {
	readonly items: readonly Item[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

function query(params: object): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params) as [string, unknown][]) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	const text = search.toString();
	return text === '' ? '' : '?' + text;
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload(response);
}

/* A reader that needs a whole set (a select box, a count) walks the cursors
   to the end. The walk stops at this many rows and reports the set as
   incomplete, so a workspace of unusual size costs a bounded number of pages. */
export const WHOLE_LIST_CAP = 1_000;
const WHOLE_LIST_PAGE = 200;

export interface WholeList<Item> {
	readonly items: readonly Item[];
	/** False when the walk hit WHOLE_LIST_CAP before the list ended. */
	readonly complete: boolean;
}

async function collectPages<Item>(
	load: (cursor: string | null) => Promise<PageResult<Item>>,
): Promise<WholeList<Item>> {
	const items: Item[] = [];
	let cursor: string | null = null;
	do {
		const result: PageResult<Item> = await load(cursor);
		items.push(...result.items);
		cursor = result.page.nextCursor;
	} while (cursor !== null && items.length < WHOLE_LIST_CAP);
	return { items, complete: cursor === null };
}

export interface AgentListRequest {
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly sort?: AgentListSort;
	readonly direction?: ListDirection;
	readonly q?: string;
}

export function loadAgentsPage(
	request: AgentListRequest = {},
): Promise<PageResult<TenantAgentView>> {
	return getJson('/api/agents' + query(request));
}

export function loadAllAgents(): Promise<WholeList<TenantAgentView>> {
	return collectPages((cursor) =>
		loadAgentsPage({ limit: WHOLE_LIST_PAGE, sort: 'name', cursor }),
	);
}

export function loadAgentContext(): Promise<{
	readonly moduleAgents: readonly ModuleAgentView[];
	readonly providers: readonly AgentProviderConnection[];
	readonly tools: readonly string[];
	readonly procedures: readonly AgentProcedure[];
}> {
	return getJson('/api/agents/context');
}

export async function updateModuleAgentBinding(
	input: UpdateModuleAgentBindingInput,
	csrfToken: string,
): Promise<ModuleAgentView> {
	const response = await fetch('/api/agents/module-bindings/update', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly agent: ModuleAgentView }>(response)).agent;
}

export async function loadAgentProviders(): Promise<{
	readonly providers: readonly AgentProviderConnection[];
	readonly readinessTtlMs: number;
}> {
	const response = await fetch('/api/agent-providers', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<{
		readonly providers: readonly AgentProviderConnection[];
		readonly readinessTtlMs: number;
	}>(response);
}

export async function createAgentProvider(
	input: CreateAgentProviderInput,
	csrfToken: string,
): Promise<AgentProviderConnection> {
	const response = await fetch('/api/agent-providers', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (
		await payload<{ readonly provider: AgentProviderConnection }>(response)
	).provider;
}

export async function updateAgentProvider(
	input: UpdateAgentProviderInput,
	csrfToken: string,
): Promise<AgentProviderConnection> {
	const response = await fetch('/api/agent-providers/update', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (
		await payload<{ readonly provider: AgentProviderConnection }>(response)
	).provider;
}

export async function testAgentProvider(
	id: string,
	model: string,
	csrfToken: string,
): Promise<AgentProviderConnection> {
	const response = await fetch('/api/agent-providers/test', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, model }),
	});
	return (
		await payload<{ readonly provider: AgentProviderConnection }>(response)
	).provider;
}

export async function deleteAgentProvider(
	id: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/agent-providers/delete', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, expectedRevision }),
	});
	await payload<{ readonly deleted: true }>(response);
}

export async function createAgent(
	input: CreateAgentInput,
	csrfToken: string,
): Promise<AgentDefinition> {
	const response = await fetch('/api/agents', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly agent: AgentDefinition }>(response)).agent;
}

export async function updateAgent(
	agentId: string,
	input: UpdateAgentInput,
	csrfToken: string,
): Promise<AgentDefinition> {
	const response = await fetch('/api/agents/update', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id: agentId, ...input }),
	});
	return (await payload<{ readonly agent: AgentDefinition }>(response)).agent;
}

export async function archiveAgent(
	id: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<AgentDefinition> {
	const response = await fetch('/api/agents/archive', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, expectedRevision }),
	});
	return (await payload<{ readonly agent: AgentDefinition }>(response)).agent;
}

export async function deleteAgent(
	id: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/agents/delete', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, expectedRevision }),
	});
	await payload<{ readonly deleted: true }>(response);
}

export async function createAgentProcedure(
	input: CreateAgentProcedureInput,
	csrfToken: string,
): Promise<AgentProcedure> {
	const response = await fetch('/api/agent-procedures', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly procedure: AgentProcedure }>(response))
		.procedure;
}

export async function updateAgentProcedure(
	procedureId: string,
	input: UpdateAgentProcedureInput,
	csrfToken: string,
): Promise<AgentProcedure> {
	const response = await fetch('/api/agent-procedures/update', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id: procedureId, ...input }),
	});
	return (await payload<{ readonly procedure: AgentProcedure }>(response))
		.procedure;
}

export async function archiveAgentProcedure(
	id: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<AgentProcedure> {
	const response = await fetch('/api/agent-procedures/archive', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, expectedRevision }),
	});
	return (await payload<{ readonly procedure: AgentProcedure }>(response))
		.procedure;
}

export async function deleteAgentProcedure(
	id: string,
	expectedRevision: number,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/agent-procedures/delete', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id, expectedRevision }),
	});
	await payload<{ readonly deleted: true }>(response);
}

export interface RunListRequest {
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly direction?: ListDirection;
	readonly status?: string;
	readonly agentId?: string;
	readonly trigger?: string;
	readonly q?: string;
}

export function loadAgentRuns(
	request: RunListRequest = {},
): Promise<PageResult<AgentRun>> {
	return getJson('/api/agent-runs' + query(request));
}

export function loadAllAgentRuns(
	filters: Pick<RunListRequest, 'status' | 'agentId' | 'trigger'>,
): Promise<WholeList<AgentRun>> {
	return collectPages((cursor) =>
		loadAgentRuns({ ...filters, limit: WHOLE_LIST_PAGE, cursor }),
	);
}

export async function loadAgentRun(runId: string): Promise<AgentRunTimeline> {
	return (
		await getJson<{ readonly run: AgentRunTimeline }>(
			'/api/agent-runs/get' + query({ id: runId }),
		)
	).run;
}

export async function loadAgentWorker(): Promise<AgentWorkerStatus> {
	const response = await fetch('/api/agent-runs/worker', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly worker: AgentWorkerStatus }>(response))
		.worker;
}

export async function cancelAgentRun(
	runId: string,
	csrfToken: string,
): Promise<AgentRunTimeline> {
	const response = await fetch('/api/agent-runs/cancel', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id: runId }),
	});
	return (await payload<{ readonly run: AgentRunTimeline }>(response)).run;
}

interface RunStreamMessage {
	readonly run?: Omit<AgentRunTimeline, 'timeline'>;
	readonly events?: readonly AgentExecutionEvent[];
	readonly error?: { readonly code: string; readonly message: string };
}

/* The server sends the run summary plus only the events after the last
   acknowledged sequence. Each batch is folded onto the timeline with the same
   function the server uses, so a live answer and a reloaded one group
   identically. The browser's own reconnect (after the server recycles the
   connection) resumes from Last-Event-ID, and a replayed sequence is dropped
   because sequences only ever move forward. */
export function observeAgentRun(
	runId: string,
	onRun: (run: AgentRunTimeline) => void,
	initial: readonly RunTimelineEntry[] = [],
): () => void {
	let timeline = initial;
	let lastSequence = timelineSequence(initial);
	const source = new EventSource(
		`/api/agent-runs/stream?id=${encodeURIComponent(runId)}&after=${lastSequence}`,
		{ withCredentials: true },
	);
	source.onmessage = (event) => {
		const value = JSON.parse(event.data) as RunStreamMessage;
		if (!value.run) return;
		const fresh = (value.events ?? []).filter(
			(item) => item.sequence > lastSequence,
		);
		if (fresh.length > 0) {
			timeline = appendRunTimeline(timeline, fresh);
			lastSequence = timelineSequence(timeline);
		}
		onRun({ ...value.run, timeline });
		if (['succeeded', 'failed', 'cancelled'].includes(value.run.status)) {
			source.close();
		}
	};
	return () => source.close();
}

export async function loadAgentUsage(days: number): Promise<AgentUsageSummary> {
	const response = await fetch(`/api/agent-usage?days=${days}`, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<AgentUsageSummary>(response);
}

export type PlaygroundRunRequest = Omit<
	EnqueueAgentRunInput,
	'trigger' | 'idempotencyKey'
>;

/* The caller owns the idempotency key so a retried submission of the same
   input lands on the same run instead of queuing a duplicate. */
export async function enqueueAgentRun(
	input: PlaygroundRunRequest,
	csrfToken: string,
	idempotencyKey: string,
): Promise<AgentRun> {
	const response = await fetch('/api/agent-runs', {
		method: 'POST',
		headers: {
			...mutationHeaders(csrfToken),
			'idempotency-key': idempotencyKey,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly run: AgentRun }>(response)).run;
}

export function loadAssistantReadiness(): Promise<AssistantReadiness> {
	return getJson('/api/assistant/readiness');
}

export function loadAssistantThreads(
	limit: number,
): Promise<PageResult<AssistantThread>> {
	return getJson('/api/assistant/threads' + query({ limit }));
}

export function loadAssistantThread(
	id: string,
): Promise<AssistantConversation> {
	return getJson('/api/assistant/threads/get' + query({ id }));
}

async function assistantPost<T>(
	path: string,
	body: object,
	csrfToken: string,
): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return payload<T>(response);
}

export function startAssistantThread(
	message: string,
	csrfToken: string,
): Promise<AssistantConversation> {
	return assistantPost('/api/assistant/threads', { message }, csrfToken);
}

export function continueAssistantThread(
	threadId: string,
	message: string,
	csrfToken: string,
): Promise<AssistantConversation> {
	return assistantPost(
		'/api/assistant/threads/continue',
		{ threadId, message },
		csrfToken,
	);
}

export async function renameAssistantThread(
	id: string,
	title: string,
	csrfToken: string,
): Promise<AssistantThread> {
	return (
		await assistantPost<{ readonly thread: AssistantThread }>(
			'/api/assistant/threads/rename',
			{ id, title },
			csrfToken,
		)
	).thread;
}

export async function deleteAssistantThread(
	id: string,
	csrfToken: string,
): Promise<void> {
	await assistantPost('/api/assistant/threads/delete', { id }, csrfToken);
}
