import { cell, createStore } from 'segment-state';
import type {
	ImportJobView,
	ImportJobRow,
	ImportJobStatus,
} from '../domain/types.ts';
import type { ImportTargetView } from '../services/import-service.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createImportClientState() {
	const store = createStore({
		jobs: cell<readonly ImportJobView[]>([]),
		targets: cell<readonly ImportTargetView[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<ImportJobStatus | ''>(''),
		targetFilter: '',
		filtersOpen: false,
		formOpen: false,
		/* Remounts the form so the native file input starts empty again. */
		formSession: 0,
		openJobId: cell<string | null>(null),
		openJob: cell<ImportJobView | null>(null),
		openJobRows: cell<readonly ImportJobRow[]>([]),
		openJobCursor: cell<string | null>(null),
		drawerError: '',
		confirmCancelId: cell<string | null>(null),
	});
	return { store, state: store.state };
}

/** Targets present in the loaded set, for the filter's option list. */
export function jobTargets(jobs: readonly ImportJobView[]): readonly string[] {
	return [...new Set(jobs.map((job) => job.target))].sort();
}
