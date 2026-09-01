import type { AgentExecutionEvent } from '@coreloom/harness';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentRun,
	AgentRunDetail,
	AgentSkill,
	AgentWorkerStatus,
	CreateAgentProviderInput,
	CreateAgentInput,
	CreateAgentSkillInput,
	EnqueueAgentRunInput,
	UpdateAgentProviderInput,
	UpdateAgentInput,
	UpdateAgentSkillInput,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The agent operation failed.');
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
	readonly agents: readonly AgentDefinition[];
	readonly providers: readonly AgentProviderConnection[];
	readonly tools: readonly string[];
	readonly skills: readonly AgentSkill[];
}> {
	const response = await fetch('/api/agents', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload(response);
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

export async function createAgentSkill(
	input: CreateAgentSkillInput,
	csrfToken: string,
): Promise<AgentSkill> {
	const response = await fetch('/api/agent-skills', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly skill: AgentSkill }>(response)).skill;
}

export async function updateAgentSkill(
	skillId: string,
	input: UpdateAgentSkillInput,
	csrfToken: string,
): Promise<AgentSkill> {
	const response = await fetch('/api/agent-skills/update', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id: skillId, ...input }),
	});
	return (await payload<{ readonly skill: AgentSkill }>(response)).skill;
}

export async function loadAgentRuns(): Promise<readonly AgentRun[]> {
	const response = await fetch('/api/agent-runs', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly runs: readonly AgentRun[] }>(response)).runs;
}

export async function loadAgentRun(runId: string): Promise<AgentRunDetail> {
	const response = await fetch(
		`/api/agent-runs?id=${encodeURIComponent(runId)}`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return (await payload<{ readonly run: AgentRunDetail }>(response)).run;
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
): Promise<AgentRunDetail> {
	const response = await fetch('/api/agent-runs/cancel', {
		method: 'POST',
		headers: mutationHeaders(csrfToken),
		credentials: 'same-origin',
		body: JSON.stringify({ id: runId }),
	});
	return (await payload<{ readonly run: AgentRunDetail }>(response)).run;
}

interface RunStreamMessage {
	readonly run?: Omit<AgentRunDetail, 'events'>;
	readonly events?: readonly AgentExecutionEvent[];
	readonly error?: { readonly code: string; readonly message: string };
}

/* The server sends the run summary plus only the events after the last
   acknowledged sequence. Events accumulate here, and the browser's own
   reconnect (after the server recycles the connection) resumes from
   Last-Event-ID, so a reconnect is invisible to the caller. */
export function observeAgentRun(
	runId: string,
	onRun: (run: AgentRunDetail) => void,
	initial: readonly AgentExecutionEvent[] = [],
): () => void {
	const events = new Map<number, AgentExecutionEvent>(
		initial.map((event) => [event.sequence, event]),
	);
	let lastSequence = Math.max(0, ...initial.map((event) => event.sequence));
	const source = new EventSource(
		`/api/agent-runs/stream?id=${encodeURIComponent(runId)}&after=${lastSequence}`,
		{ withCredentials: true },
	);
	source.onmessage = (event) => {
		const value = JSON.parse(event.data) as RunStreamMessage;
		if (!value.run) return;
		for (const item of value.events ?? []) {
			events.set(item.sequence, item);
			lastSequence = Math.max(lastSequence, item.sequence);
		}
		onRun({
			...value.run,
			events: [...events.values()].sort(
				(left, right) => left.sequence - right.sequence,
			),
		});
		if (['succeeded', 'failed', 'cancelled'].includes(value.run.status)) {
			source.close();
		}
	};
	return () => source.close();
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
