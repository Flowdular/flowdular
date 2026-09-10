import { cell, createStore } from 'segment-state';
import type {
	AgentProviderConnection,
	AgentDefinition,
	AgentRun,
	AgentRunTimeline,
	AgentProcedure,
	AgentUsageSummary,
	AgentWorkerStatus,
	ModuleAgentView,
} from '../domain/types.ts';

export function createAgentClientState() {
	const store = createStore({
		agents: cell<readonly AgentDefinition[]>([]),
		moduleAgents: cell<readonly ModuleAgentView[]>([]),
		runs: cell<readonly AgentRun[]>([]),
		providers: cell<readonly AgentProviderConnection[]>([]),
		tools: cell<readonly string[]>([]),
		procedures: cell<readonly AgentProcedure[]>([]),
		selectedAgentId: '',
		selectedModuleAgentId: '',
		selectedRun: cell<AgentRunTimeline | null>(null),
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		moduleQuery: '',
		editorOpen: false,
		moduleEditorOpen: false,
		lifecycleAction: cell<'archive' | 'delete' | ''>(''),
		playgroundInput: '',
		/* Fixed per submission: a retry of the same input reuses it. */
		playgroundKey: '',
		worker: cell<AgentWorkerStatus | null>(null),
	});
	return { store, state: store.state };
}

export function createAgentRunClientState() {
	const store = createStore({
		runs: cell<readonly AgentRun[]>([]),
		selectedRun: cell<AgentRunTimeline | null>(null),
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		statusFilter: '',
		agentFilter: '',
		triggerFilter: '',
		filtersOpen: false,
		detailOpen: false,
	});
	return { store, state: store.state };
}

/* Which tool rows the reader opened. Held per timeline instance, so switching
   run resets it through the component key. */
export function createRunTimelineState() {
	const store = createStore({ expanded: cell<readonly number[]>([]) });
	return { store, state: store.state };
}

export function createAgentProcedureClientState() {
	const store = createStore({
		procedures: cell<readonly AgentProcedure[]>([]),
		tools: cell<readonly string[]>([]),
		selectedProcedureId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		editorOpen: false,
		lifecycleAction: cell<'archive' | 'delete' | ''>(''),
	});
	return { store, state: store.state };
}

export function createAgentUsageClientState() {
	const store = createStore({
		summary: cell<AgentUsageSummary | null>(null),
		status: cell<'idle' | 'loading'>('idle'),
		error: '',
		days: 30,
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
		deleteOpen: false,
		testingModel: '',
		readinessTtlMs: 86_400_000,
	});
	return { store, state: store.state };
}
