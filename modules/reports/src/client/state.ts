import { cell, createStore } from 'segment-state';
import type { ReportRange } from '../domain/providers.ts';
import type { WorkspaceReport } from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus = 'idle' | 'loading' | 'denied' | 'error';

export function createReportsClientState() {
	const store = createStore({
		reports: cell<readonly WorkspaceReport[]>([]),
		/* The range the server answered for, not the one the fields hold: the
		   two differ while a reader is editing the dates. */
		range: cell<ReportRange | null>(null),
		unavailable: cell<readonly string[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		from: '',
		to: '',
	});
	return { store, state: store.state };
}

export function createReportsWidgetState() {
	const store = createStore({
		reports: cell<readonly WorkspaceReport[]>([]),
	});
	return { store, state: store.state };
}
