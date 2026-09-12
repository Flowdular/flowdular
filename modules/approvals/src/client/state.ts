import { cell, createStore } from 'segment-state';
import type {
	ApprovalRequest,
	ApprovalRequestView,
	ApprovalStatus,
} from '../domain/types.ts';
import type { ApprovalsListScope } from './api.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createApprovalsClientState() {
	const store = createStore({
		requests: cell<readonly ApprovalRequest[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		/* The inbox opens on what the member can act on, not on everything. */
		scope: cell<ApprovalsListScope>('decidable'),
		statusFilter: cell<ApprovalStatus | ''>(''),
		filtersOpen: false,
		selectedId: cell<string | null>(null),
		selected: cell<ApprovalRequestView | null>(null),
		comment: '',
	});
	return { store, state: store.state };
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
