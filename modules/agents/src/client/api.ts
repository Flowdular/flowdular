import type { AgentExecutionEvent } from '@flowdular/harness';
import { t } from '@flowdular/client/i18n';
import {
	appendRunTimeline,
	timelineSequence,
	type RunTimelineEntry,
} from '../domain/run-timeline.ts';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentRun,
	AgentRunTimeline,
	AgentProcedure,
	AgentUsageSummary,
	AgentWorkerStatus,
	CreateAgentProviderInput,
	CreateAgentInput,
	CreateAgentProcedureInput,
	EnqueueAgentRunInput,
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

export async function loadAgents(): Promise<{
	readonly agents: readonly TenantAgentView[];
	readonly moduleAgents: readonly ModuleAgentView[];
	readonly providers: readonly AgentProviderConnection[];
	readonly tools: readonly string[];
	readonly procedures: readonly AgentProcedure[];
}> {
	const response = await fetch('/api/agents', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload(response);
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

export async function loadAgentRuns(): Promise<readonly AgentRun[]> {
	const response = await fetch('/api/agent-runs', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly runs: readonly AgentRun[] }>(response)).runs;
}

export async function loadAgentRun(runId: string): Promise<AgentRunTimeline> {
	const response = await fetch(
		`/api/agent-runs?id=${encodeURIComponent(runId)}`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return (await payload<{ readonly run: AgentRunTimeline }>(response)).run;
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
