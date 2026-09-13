import { cell, createStore } from 'segment-state';
import type { TableSort } from '@flowdular/ui';
import type {
	AgentProviderConnection,
	AgentDefinition,
	AgentRun,
	AgentRunTimeline,
	AgentProcedure,
	AgentUsageSummary,
	AgentWorkerStatus,
	ListDirection,
	ModuleAgentView,
} from '../domain/types.ts';

export const PAGE_SIZE = 25;

/**
 * The cursor that opened each page the reader has seen. `cursors[0]` is null
 * for the first page and `cursors[i]` is the cursor the server returned with
 * page `i - 1`, so going back reuses a stored cursor and a page past the last
 * known one cannot be opened. A filter or sort change throws the stack away.
 */
export interface CursorStack {
	readonly pageIndex: number;
	readonly cursors: readonly (string | null)[];
}

export const FIRST_PAGE: CursorStack = { pageIndex: 0, cursors: [null] };

export function pageCursor(stack: CursorStack): string | null {
	return stack.cursors[stack.pageIndex] ?? null;
}

export function hasMorePages(stack: CursorStack): boolean {
	return typeof stack.cursors[stack.pageIndex + 1] === 'string';
}

/* Records what follows the page on screen and forgets the pages behind it: a
   set that changed under the reader hands out fresh cursors from here on. */
export function pageLoaded(
	stack: CursorStack,
	nextCursor: string | null,
): CursorStack {
	return {
		pageIndex: stack.pageIndex,
		cursors: [
			...stack.cursors.slice(0, stack.pageIndex + 1),
			...(nextCursor === null ? [] : [nextCursor]),
		],
	};
}

export function moveToPage(stack: CursorStack, pageIndex: number): CursorStack {
	const index = Math.min(
		Math.max(0, Math.trunc(pageIndex)),
		stack.cursors.length - 1,
	);
	return index === stack.pageIndex ? stack : { ...stack, pageIndex: index };
}

export const DEFAULT_AGENT_SORT: readonly TableSort[] = [
	{ key: 'name', desc: false },
];

/* The table reports an empty state when a header toggles past descending; the
   list then falls back to its default order rather than an unsorted page. */
export function agentSorting(
	sorts: readonly TableSort[],
): readonly TableSort[] {
	const sort = sorts.find(
		(candidate) => candidate.key === 'name' || candidate.key === 'updatedAt',
	);
	return sort ? [sort] : DEFAULT_AGENT_SORT;
}

export function runDirection(sorts: readonly TableSort[]): ListDirection {
	const sort = sorts.find((candidate) => candidate.key === 'queuedAt');
	return sort && !sort.desc ? 'asc' : 'desc';
}

export interface AgentOption {
	readonly id: string;
	readonly name: string;
}

/* The agent filter offers every agent seen in a loaded page, so an option
   never disappears when the reader pages away from the runs that named it. */
export function mergeAgentOptions(
	options: readonly AgentOption[],
	runs: readonly AgentRun[],
): readonly AgentOption[] {
	const known = new Map(options.map((option) => [option.id, option]));
	let changed = false;
	for (const run of runs) {
		if (known.has(run.agentId)) continue;
		known.set(run.agentId, { id: run.agentId, name: run.agentName });
		changed = true;
	}
	if (!changed) return options;
	return [...known.values()].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

export function createAgentClientState() {
	const store = createStore({
		agents: cell<readonly AgentDefinition[]>([]),
		moduleAgents: cell<readonly ModuleAgentView[]>([]),
		runs: cell<readonly AgentRun[]>([]),
		providers: cell<readonly AgentProviderConnection[]>([]),
		tools: cell<readonly string[]>([]),
		procedures: cell<readonly AgentProcedure[]>([]),
		page: cell<CursorStack>(FIRST_PAGE),
		sorting: cell<readonly TableSort[]>(DEFAULT_AGENT_SORT),
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
		page: cell<CursorStack>(FIRST_PAGE),
		direction: cell<ListDirection>('desc'),
		agentOptions: cell<readonly AgentOption[]>([]),
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
