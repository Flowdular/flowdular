import type { TableSort } from '@flowdular/ui';
import { cell, createStore } from 'segment-state';
import type {
	WorkflowDefinition,
	WorkflowDefinitionDetail,
	WorkflowDryRunResponseV1,
	WorkflowGraphV1,
	WorkflowRunDetail,
	WorkflowRunSummary,
	WorkflowSortDirection,
} from '../domain/types.ts';
import type {
	WorkflowActionCatalogItem,
	WorkflowAgentCatalogItem,
} from './api.ts';

/**
 * The pages a reader has walked. `cursors[i]` is the cursor that opened page
 * `i`; page 0 opens with none. `nextCursor` is what the page on screen handed
 * back, null on the last page.
 */
export interface PageCursors {
	readonly pageIndex: number;
	readonly cursors: readonly string[];
	readonly nextCursor: string | null;
}

export const FIRST_PAGE: PageCursors = {
	pageIndex: 0,
	cursors: [],
	nextCursor: null,
};

export interface PageRequest {
	readonly pageIndex: number;
	readonly cursor: string | null;
}

export const FIRST_PAGE_REQUEST: PageRequest = { pageIndex: 0, cursor: null };

/**
 * How to reach `pageIndex` from the pages walked so far: an earlier page
 * reopens with the cursor stored for it, the next page with the cursor the
 * current one handed back. Null when no cursor leads there.
 */
export function pageRequest(
	pages: PageCursors,
	pageIndex: number,
): PageRequest | null {
	if (pageIndex <= 0) return { pageIndex: 0, cursor: null };
	if (pageIndex <= pages.pageIndex) {
		const cursor = pages.cursors[pageIndex];
		return cursor ? { pageIndex, cursor } : null;
	}
	if (pageIndex === pages.pageIndex + 1 && pages.nextCursor) {
		return { pageIndex, cursor: pages.nextCursor };
	}
	return null;
}

/** The pages walked once the requested one arrived with `nextCursor` behind it. */
export function pageOpened(
	pages: PageCursors,
	request: PageRequest,
	nextCursor: string | null,
): PageCursors {
	const cursors = pages.cursors.slice(0, request.pageIndex);
	while (cursors.length < request.pageIndex) cursors.push('');
	cursors.push(request.cursor ?? '');
	return { pageIndex: request.pageIndex, cursors, nextCursor };
}

export interface ListOrder<Sort extends string> {
	readonly sort: Sort;
	readonly direction: WorkflowSortDirection;
}

/**
 * The server order a table's sorting state asks for. `columns` maps a column
 * key to the sort key it carries; a table sorted by nothing, or by a column
 * the server does not sort on, asks for the default order.
 */
export function listOrder<Sort extends string>(
	sorts: readonly TableSort[],
	columns: Readonly<Record<string, Sort>>,
	fallback: ListOrder<Sort>,
): ListOrder<Sort> {
	const first = sorts[0];
	const sort = first ? columns[first.key] : undefined;
	return first && sort
		? { sort, direction: first.desc ? 'desc' : 'asc' }
		: fallback;
}

/**
 * Whether the typed term still has to reach the server. The rows on screen
 * answer it only once a page was loaded with exactly this term.
 */
export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}

export function createWorkflowsClientState() {
	const store = createStore({
		definitions: cell<readonly WorkflowDefinition[]>([]),
		definitionSorts: cell<readonly TableSort[]>([]),
		definitionPages: cell<PageCursors>(FIRST_PAGE),
		/* The term the rows on screen were loaded with. */
		appliedQuery: '',
		runs: cell<readonly WorkflowRunSummary[]>([]),
		runSorts: cell<readonly TableSort[]>([]),
		runPages: cell<PageCursors>(FIRST_PAGE),
		appliedRunQuery: '',
		detail: cell<WorkflowDefinitionDetail | null>(null),
		graph: cell<WorkflowGraphV1 | null>(null),
		selectedNodeId: '',
		selectedEdgeId: '',
		connectionSource: cell<{
			readonly nodeId: string;
			readonly port: string;
		} | null>(null),
		selectedRun: cell<WorkflowRunDetail | null>(null),
		agents: cell<readonly WorkflowAgentCatalogItem[]>([]),
		actions: cell<readonly WorkflowActionCatalogItem[]>([]),
		validation: cell<WorkflowDryRunResponseV1 | null>(null),
		liveValidation: cell<WorkflowDryRunResponseV1 | null>(null),
		validating: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		notice: '',
		dirty: false,
		saving: false,
		query: '',
		statusFilter: '',
		filtersOpen: false,
		runQuery: '',
		runStatusFilter: '',
		runFiltersOpen: false,
		createOpen: false,
		fixturesOpen: false,
		liveConfirmOpen: false,
		deleteConfirmOpen: false,
		lifecycleTarget: cell<WorkflowDefinition | null>(null),
		inputText: '{}',
		fixturesText: '[]',
		editorName: '',
		editorDescription: '',
		editorMode: cell<'catalog' | 'editor'>('catalog'),
		panel: cell<'inspector' | 'validation' | 'test' | 'history'>('inspector'),
	});
	return { store, state: store.state };
}
