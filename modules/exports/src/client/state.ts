import { cell, createStore } from 'segment-state';
import type {
	ExportJobStatus,
	ExportJobView,
	ExportListView,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus = 'idle' | 'loading' | 'denied' | 'error';

/** What the start control renders once the catalogue answered, or did not. */
export type StartState = 'loading' | 'denied' | 'error' | 'empty' | 'ready';

export function createExportsClientState() {
	const store = createStore({
		jobs: cell<readonly ExportJobView[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		statusFilter: cell<ExportJobStatus | ''>(''),
		nextCursor: cell<string | null>(null),
		/** The job whose file is being opened, so one click cannot queue two. */
		openingId: cell<string | null>(null),
		lists: cell<readonly ExportListView[]>([]),
		listsStatus: cell<ScreenStatus>('loading'),
		listsError: '',
		selectedListId: '',
		/** True while a start is in flight, so one click cannot queue two. */
		starting: false,
	});
	return { store, state: store.state };
}

/**
 * The lists the control offers. A list the reader does not hold the permission
 * for is left out rather than offered and refused: the server decides the same
 * way on the live principal, so offering it could only produce a 403.
 */
export function startableLists(
	lists: readonly ExportListView[],
): readonly ExportListView[] {
	return lists.filter((entry) => entry.permitted);
}

/**
 * One of the five states the control renders. The catalogue is read once, so
 * `loading` is the first read alone and a refresh keeps what is on screen.
 */
export function startState(
	status: ScreenStatus,
	lists: readonly ExportListView[],
): StartState {
	if (status === 'denied') return 'denied';
	if (status === 'error') return 'error';
	if (status === 'loading' && lists.length === 0) return 'loading';
	return startableLists(lists).length === 0 ? 'empty' : 'ready';
}
