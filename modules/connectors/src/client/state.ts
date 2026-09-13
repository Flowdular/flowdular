import type { TableSort } from '@flowdular/ui';
import { cell, createStore, type Ref, type Store } from 'segment-state';
import type {
	ConnectorCallListRow,
	ConnectorCallOutcome,
	ConnectorDefinition,
	ConnectorInstance,
	ConnectorInstanceStatus,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

/** What a test call reported, held only while the drawer is open. */
export interface TestCallReport {
	readonly outcome: ConnectorCallOutcome;
	readonly status: number | null;
	readonly errorClass: string | null;
	readonly durationMs: number;
	readonly bodyPreview: string;
}

/**
 * Which manage action is waiting for its confirmation dialog. Consent is one
 * entry per caller kind: a dialog that moved both at once could not state the
 * value it was about to write.
 */
export type ConnectorConfirm =
	| 'disable'
	| 'delete'
	| 'consent-workflows'
	| 'consent-agents';

/**
 * Which cursor opened each page: `cursors[i]` opened page i and page 0 has
 * none. Going back reuses the stored cursor; going forward records the one the
 * page on screen handed out. A new listing starts again from `FIRST_PAGE`.
 */
export interface PageWalk {
	readonly pageIndex: number;
	readonly cursors: readonly (string | null)[];
}

export const FIRST_PAGE: PageWalk = { pageIndex: 0, cursors: [null] };

/** The walk after a page change; the same walk when the page is unreachable. */
export function walkTo(
	walk: PageWalk,
	target: number,
	nextCursor: string | null,
): PageWalk {
	const index = Number.isFinite(target) ? Math.max(0, Math.trunc(target)) : 0;
	if (index === walk.pageIndex) return walk;
	if (index === walk.pageIndex + 1 && nextCursor !== null) {
		return {
			pageIndex: index,
			cursors: [...walk.cursors.slice(0, index), nextCursor],
		};
	}
	if (index < walk.cursors.length)
		return { pageIndex: index, cursors: walk.cursors };
	return walk;
}

export function pageCursor(walk: PageWalk): string | null {
	return walk.cursors[walk.pageIndex] ?? null;
}

/**
 * A ticket for one load. Loads overlap (a page turn, the search debounce, a
 * filter change), and only the newest one's answer may reach the screen: an
 * older answer would show rows of a listing the controls no longer describe.
 */
type LoadStore = Pick<Store<unknown>, 'get' | 'set'>;

export function beginLoad(store: LoadStore, loads: Ref<number>): number {
	const ticket = store.get(loads) + 1;
	store.set(loads, ticket, 'connectors/load');
	return ticket;
}

export function isLatestLoad(
	store: LoadStore,
	loads: Ref<number>,
	ticket: number,
): boolean {
	return store.get(loads) === ticket;
}

/**
 * The instance filter's options: the instances the page on screen names, plus
 * the one already chosen so the choice stays visible while it narrows the page
 * to itself. A deleted instance is offered by its id.
 */
export function instanceChoices(
	calls: readonly ConnectorCallListRow[],
	selected: string,
): readonly { readonly value: string; readonly label: string }[] {
	const names = new Map<string, string>();
	for (const call of calls) {
		if (!names.has(call.instanceId)) {
			names.set(call.instanceId, call.instanceName ?? call.instanceId);
		}
	}
	if (selected !== '' && !names.has(selected)) names.set(selected, selected);
	return [...names]
		.map(([value, label]) => ({ value, label }))
		.sort((left, right) => left.label.localeCompare(right.label));
}

/** Whether the term in the search box is not yet the one the rows answer. */
export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}

/** The order the table shows, as the server's `sort` and `direction`. */
export function sortRequest(
	sorts: readonly TableSort[],
	fallback: TableSort,
): { readonly sort: string; readonly direction: 'asc' | 'desc' } {
	const first = sorts[0] ?? fallback;
	return { sort: first.key, direction: first.desc ? 'desc' : 'asc' };
}

export function createConnectorsClientState() {
	const store = createStore({
		instances: cell<readonly ConnectorInstance[]>([]),
		definitions: cell<readonly ConnectorDefinition[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		appliedQuery: '',
		statusFilter: cell<ConnectorInstanceStatus | ''>(''),
		definitionFilter: '',
		sorting: cell<readonly TableSort[]>([{ key: 'name', desc: false }]),
		pageSize: 25,
		walk: cell<PageWalk>(FIRST_PAGE),
		nextCursor: cell<string | null>(null),
		loads: 0,
		/* The record an action just returned, for a drawer whose instance the
		   page on screen does not hold. */
		pinned: cell<ConnectorInstance | null>(null),
		filtersOpen: false,
		editorOpen: false,
		selectedId: '',
		formSession: 0,
		test: cell<TestCallReport | null>(null),
		confirm: cell<ConnectorConfirm | null>(null),
	});
	return { store, state: store.state };
}

export function createConnectorCallsClientState() {
	const store = createStore({
		calls: cell<readonly ConnectorCallListRow[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		appliedQuery: '',
		outcomeFilter: cell<ConnectorCallOutcome | ''>(''),
		instanceFilter: '',
		sorting: cell<readonly TableSort[]>([{ key: 'occurredAt', desc: true }]),
		pageSize: 50,
		walk: cell<PageWalk>(FIRST_PAGE),
		nextCursor: cell<string | null>(null),
		loads: 0,
		filtersOpen: false,
	});
	return { store, state: store.state };
}
