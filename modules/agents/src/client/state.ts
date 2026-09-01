import { cell, createStore } from 'segment-state';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentRun,
	AgentRunDetail,
	AgentSkill,
	AgentWorkerStatus,
} from '../domain/types.ts';

export function createAgentClientState() {
	const store = createStore({
		agents: cell<readonly AgentDefinition[]>([]),
		runs: cell<readonly AgentRun[]>([]),
		providers: cell<readonly AgentProviderConnection[]>([]),
		tools: cell<readonly string[]>([]),
		skills: cell<readonly AgentSkill[]>([]),
		selectedAgentId: '',
		selectedRun: cell<AgentRunDetail | null>(null),
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		editorOpen: false,
		playgroundInput: '',
		/* Fixed per submission: a retry of the same input reuses it. */
		playgroundKey: '',
		worker: cell<AgentWorkerStatus | null>(null),
	});
	return { store, state: store.state };
}

export function createAgentSkillClientState() {
	const store = createStore({
		skills: cell<readonly AgentSkill[]>([]),
		tools: cell<readonly string[]>([]),
		selectedSkillId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		editorOpen: false,
	});
	return { store, state: store.state };
}

export function createAgentProviderClientState() {
	const store = createStore({
		providers: cell<readonly AgentProviderConnection[]>([]),
		selectedProviderId: '',
		kind: 'openai',
		status: cell<'idle' | 'loading' | 'submitting' | 'testing'>('idle'),
		error: '',
		query: '',
		editorOpen: false,
		testingModel: '',
		readinessTtlMs: 86_400_000,
	});
	return { store, state: store.state };
}
