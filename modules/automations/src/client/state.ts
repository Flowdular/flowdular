import { cell, createStore } from 'segment-state';
import type { TableSort } from '@flowdular/ui';
import type {
	AutomationSchedule,
	AutomationTargetOption,
	AutomationTrigger,
} from '../domain/types.ts';
import type { VariableDefinition } from '@flowdular/contracts';
import type { AutomationListRequest, AutomationListSortKey } from './api.ts';

export const AUTOMATION_LIST_PAGE_SIZE = 25;

/**
 * Where the reader is in a keyset list: `cursors[pageIndex]` is the cursor
 * that opened that page, so page 0 holds null and going back reopens a page
 * with the cursor it was first opened with.
 */
export interface AutomationListPaging {
	readonly pageIndex: number;
	readonly cursors: readonly (string | null)[];
	/** The cursor the page on screen handed back; null on the last page. */
	readonly nextCursor: string | null;
}

export const FIRST_PAGE: AutomationListPaging = {
	pageIndex: 0,
	cursors: [null],
	nextCursor: null,
};

/** The page that just loaded told us whether another follows. */
export function pageLoaded(
	paging: AutomationListPaging,
	nextCursor: string | null,
): AutomationListPaging {
	return { ...paging, nextCursor };
}

/**
 * Moves to a page the stack can reach: any page already opened, or the next
 * one while the page on screen handed back a cursor. Anything else stays put.
 */
export function movePage(
	paging: AutomationListPaging,
	pageIndex: number,
): AutomationListPaging {
	if (pageIndex < 0 || pageIndex === paging.pageIndex) return paging;
	if (pageIndex < paging.cursors.length) {
		return { ...paging, pageIndex, nextCursor: null };
	}
	if (pageIndex === paging.pageIndex + 1 && paging.nextCursor !== null) {
		return {
			pageIndex,
			cursors: [...paging.cursors, paging.nextCursor],
			nextCursor: null,
		};
	}
	return paging;
}

/** The sort the table shows, as the one key and direction the server orders by. */
export function listSort(sorting: readonly TableSort[]): {
	readonly sort: AutomationListSortKey;
	readonly direction: 'asc' | 'desc';
} {
	const first = sorting[0];
	if (first && (first.key === 'label' || first.key === 'updatedAt')) {
		return { sort: first.key, direction: first.desc ? 'desc' : 'asc' };
	}
	return { sort: 'label', direction: 'asc' };
}

export function listRequest(input: {
	readonly sorting: readonly TableSort[];
	readonly query: string;
	readonly enabledOnly: boolean;
	readonly paging: AutomationListPaging;
}): AutomationListRequest {
	return {
		...listSort(input.sorting),
		query: input.query,
		enabledOnly: input.enabledOnly,
		limit: AUTOMATION_LIST_PAGE_SIZE,
		cursor: input.paging.cursors[input.paging.pageIndex] ?? null,
	};
}

export function createAutomationScheduleClientState() {
	const store = createStore({
		schedules: cell<readonly AutomationSchedule[]>([]),
		targets: cell<readonly AutomationTargetOption[]>([]),
		variables: cell<readonly VariableDefinition[]>([]),
		timeZone: 'UTC',
		selectedScheduleId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		notice: '',
		query: '',
		enabledOnly: false,
		sorting: cell<readonly TableSort[]>([]),
		paging: cell<AutomationListPaging>(FIRST_PAGE),
		filtersOpen: false,
		editorOpen: false,
	});
	return { store, state: store.state };
}

export function createAutomationTriggerClientState() {
	const store = createStore({
		triggers: cell<readonly AutomationTrigger[]>([]),
		targets: cell<readonly AutomationTargetOption[]>([]),
		selectedTriggerId: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		enabledOnly: false,
		sorting: cell<readonly TableSort[]>([]),
		paging: cell<AutomationListPaging>(FIRST_PAGE),
		filtersOpen: false,
		editorOpen: false,
		revealedSecret: '',
	});
	return { store, state: store.state };
}
