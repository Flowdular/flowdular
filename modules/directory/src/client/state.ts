import type { TableSort } from '@flowdular/ui';
import { cell, createStore } from 'segment-state';
import type {
	GroupSortKey,
	ListDirection,
	ProvisioningEvent,
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimGroupMapping,
	ScimToken,
	TokenSortKey,
} from '../domain/types.ts';

/** Rows one screen page asks for; the server bounds it too. */
export const PAGE_SIZE = 50;

/**
 * The pages a screen has walked: `cursors[index]` is the cursor that opened
 * page `index`, and page 0 has none. Going back reuses the stored cursor, so a
 * page reads the rows it read before; a page never reached cannot be opened.
 */
export interface ListPaging {
	readonly pageIndex: number;
	readonly cursors: readonly (string | null)[];
}

export const FIRST_PAGE: ListPaging = { pageIndex: 0, cursors: [null] };

export function pageCursor(paging: ListPaging): string | null {
	return paging.cursors[paging.pageIndex] ?? null;
}

export function hasNextPage(paging: ListPaging): boolean {
	return paging.cursors.length > paging.pageIndex + 1;
}

/**
 * Records what the page on screen answered. The pages behind it were opened
 * from a cursor this answer replaces, so they are forgotten with it.
 */
export function pageLoaded(
	paging: ListPaging,
	nextCursor: string | null,
): ListPaging {
	const cursors = paging.cursors.slice(0, paging.pageIndex + 1);
	if (nextCursor !== null) cursors.push(nextCursor);
	return { pageIndex: paging.pageIndex, cursors };
}

/** Turns to a page the screen has a cursor for; any other request is ignored. */
export function turnTo(paging: ListPaging, pageIndex: number): ListPaging {
	if (
		pageIndex === paging.pageIndex ||
		pageIndex < 0 ||
		pageIndex >= paging.cursors.length
	) {
		return paging;
	}
	return { pageIndex, cursors: paging.cursors };
}

export interface ListSort<Key extends string> {
	readonly sort: Key;
	readonly direction: ListDirection;
}

/**
 * The table's sort report as the request the server takes. The header cycles
 * through ascending, descending and none, and none means the list's default.
 */
export function sortOf<Key extends string>(
	sorts: readonly TableSort[],
	keys: readonly Key[],
	fallback: Key,
): ListSort<Key> {
	const first = sorts[0];
	if (first && (keys as readonly string[]).includes(first.key)) {
		return { sort: first.key as Key, direction: first.desc ? 'desc' : 'asc' };
	}
	return { sort: fallback, direction: 'asc' };
}

export function sortingState(sort: ListSort<string>): readonly TableSort[] {
	return [{ key: sort.sort, desc: sort.direction === 'desc' }];
}

/**
 * The listing loads a screen has fired. Responses land in any order, so only
 * the load fired last may write rows; an older one is discarded on arrival,
 * or it would show rows of a filter, sort or page the controls no longer name.
 */
export interface LoadSequence {
	/** Fires a load and answers its ticket. */
	begin(): number;
	isLatest(ticket: number): boolean;
}

export function createLoadSequence(): LoadSequence {
	let issued = 0;
	return {
		begin: () => (issued += 1),
		isLatest: (ticket) => ticket === issued,
	};
}

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export type TokenConfirm = 'rotate' | 'revoke';

export function createScimTokensClientState() {
	const store = createStore({
		tokens: cell<readonly ScimToken[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		/** The term the rows on screen answer, so typing it again loads nothing. */
		appliedQuery: '',
		statusFilter: cell<ScimToken['status'] | ''>(''),
		sort: cell<ListSort<TokenSortKey>>({ sort: 'label', direction: 'asc' }),
		paging: cell<ListPaging>(FIRST_PAGE),
		filtersOpen: false,
		editorOpen: false,
		selectedId: '',
		/** The expiry field's own `YYYY-MM-DDTHH:mm` reading, empty for none. */
		expiresAt: '',
		/* Held only until the drawer closes; the server never returns it again. */
		revealedToken: '',
		confirm: cell<TokenConfirm | null>(null),
	});
	return { store, state: store.state, loads: createLoadSequence() };
}

export function createGroupMappingsClientState() {
	const store = createStore({
		groups: cell<readonly ScimGroupMapping[]>([]),
		roles: cell<readonly string[]>([]),
		defaultRole: '',
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		appliedQuery: '',
		sort: cell<ListSort<GroupSortKey>>({
			sort: 'precedence',
			direction: 'asc',
		}),
		paging: cell<ListPaging>(FIRST_PAGE),
		editorOpen: false,
		selectedId: '',
		roleKey: '',
		precedence: '',
	});
	return { store, state: store.state, loads: createLoadSequence() };
}

export function createProvisioningLogClientState() {
	const store = createStore({
		events: cell<readonly ProvisioningEvent[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		operationFilter: cell<ProvisioningOperation | ''>(''),
		outcomeFilter: cell<ProvisioningOutcome | ''>(''),
		filtersOpen: false,
		/* Null once the server stops handing one back: that is the last page. */
		nextCursor: cell<string | null>(null),
	});
	return { store, state: store.state };
}
