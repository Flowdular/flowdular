import { cell, createStore } from 'segment-state';
import type { MeterLimit, MeterUsage } from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus = 'idle' | 'loading' | 'denied' | 'error';

export function createUsageClientState() {
	const store = createStore({
		meters: cell<readonly MeterUsage[]>([]),
		/* The server's own warning share, so the screen colours what the inbox
		   notifies on rather than a second copy of the rule. */
		warningPercent: cell<number>(80),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		moduleFilter: '',
		filtersOpen: false,
	});
	return { store, state: store.state };
}

export function createLimitsClientState() {
	const store = createStore({
		limits: cell<readonly MeterLimit[]>([]),
		meters: cell<readonly MeterUsage[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
	});
	return { store, state: store.state };
}
