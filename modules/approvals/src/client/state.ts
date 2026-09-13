import { cell, createStore } from 'segment-state';
import type {
	ApprovalDecideOutcome,
	ApprovalListDirection,
	ApprovalRequest,
	ApprovalRequestView,
	ApprovalStatus,
} from '../domain/types.ts';
import type { ApprovalsListScope, BulkDecision } from './api.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

/**
 * The cursors of the pages the member has walked: `stack[pageIndex]` is the
 * cursor that opened that page, page 0 has none, and going back reuses the
 * stored cursor rather than asking the server for a position it never named.
 */
export type CursorStack = readonly (string | null)[];

export const FIRST_PAGE: CursorStack = [null];

export function pageCursor(
	stack: CursorStack,
	pageIndex: number,
): string | null {
	return stack[pageIndex] ?? null;
}

/** Whether the stack knows how to open this page. */
export function canOpenPage(stack: CursorStack, pageIndex: number): boolean {
	return pageIndex >= 0 && pageIndex < stack.length;
}

/**
 * The stack after `pageIndex` loaded and answered `nextCursor`. Pages past the
 * one that loaded are forgotten: the set may have moved under them.
 */
export function recordNextCursor(
	stack: CursorStack,
	pageIndex: number,
	nextCursor: string | null,
): CursorStack {
	const kept = stack.slice(0, pageIndex + 1);
	return nextCursor === null ? kept : [...kept, nextCursor];
}

export const DEFAULT_PAGE_SIZE = 25;

export function createApprovalsClientState() {
	const store = createStore({
		requests: cell<readonly ApprovalRequest[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		/* The inbox opens on what the member can act on, not on everything. */
		scope: cell<ApprovalsListScope>('decidable'),
		statusFilter: cell<ApprovalStatus | ''>(''),
		/* Newest first; the one sort key the list offers is createdAt. */
		direction: cell<ApprovalListDirection>('desc'),
		pageIndex: 0,
		pageSize: DEFAULT_PAGE_SIZE,
		cursors: cell<CursorStack>(FIRST_PAGE),
		filtersOpen: false,
		selectedId: cell<string | null>(null),
		selected: cell<ApprovalRequestView | null>(null),
		comment: '',
		/* Row ids checked in the table; the screen owns it and empties it with
		   every new listing, the table never clears it. */
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		confirmDecision: cell<BulkDecision | null>(null),
		bulkComment: '',
	});
	return { store, state: store.state };
}

/** The selected rows a bulk decision may name: the pending ones on screen. */
export function decidableIds(
	requests: readonly ApprovalRequest[],
	selected: ReadonlySet<string>,
): readonly string[] {
	return requests
		.filter(
			(request) => selected.has(request.id) && request.status === 'pending',
		)
		.map((request) => request.id);
}

/** How many ids each outcome covered, for the notice after a bulk decision. */
export function decideOutcomeCounts(
	outcomes: readonly ApprovalDecideOutcome[],
): {
	readonly decided: number;
	readonly missing: number;
	readonly refused: number;
} {
	let decided = 0;
	let missing = 0;
	let refused = 0;
	for (const entry of outcomes) {
		if (entry.outcome === 'decided') decided += 1;
		else if (entry.outcome === 'not-found') missing += 1;
		else refused += 1;
	}
	return { decided, missing, refused };
}

/** Which of the five states the inbox renders. */
export type ApprovalsScreen = 'denied' | 'error' | 'table';

export interface ApprovalsListing {
	readonly visible: readonly ApprovalRequest[];
	readonly filtered: boolean;
	readonly activeFilters: number;
	readonly screen: ApprovalsScreen;
}

/* The server already filtered by scope and status; this only reports what the
   table has to say about an empty result. A load that failed answers with the
   error state: the table would report an empty inbox instead, which is the one
   answer a failed load must never give. */
export function approvalsListing(
	requests: readonly ApprovalRequest[],
	scope: ApprovalsListScope,
	statusFilter: ApprovalStatus | '',
	status: ScreenStatus = 'idle',
): ApprovalsListing {
	const activeFilters =
		(scope === 'decidable' ? 0 : 1) + (statusFilter === '' ? 0 : 1);
	return {
		visible: requests,
		filtered: activeFilters > 0,
		activeFilters,
		screen:
			status === 'denied' ? 'denied' : status === 'error' ? 'error' : 'table',
	};
}
