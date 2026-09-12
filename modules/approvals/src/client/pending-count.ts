import { cell, createStore } from 'segment-state';
import { loadPendingCount } from './api.ts';

/* One count behind the dashboard tile and the Approvals screen. The screen
   reports what it just decided, so the tile follows a real event instead of
   polling for one. */
const store = createStore({ pending: cell(0) });

export const pendingCount = store.state.pending;

export function clearPendingCount(): void {
	store.set(store.state.pending, 0, 'approvals/pending-cleared');
}

export async function refreshPendingCount(): Promise<void> {
	try {
		store.set(
			store.state.pending,
			await loadPendingCount(),
			'approvals/pending-loaded',
		);
	} catch {
		/* The tile is an accessory. A failed count keeps the last one rather than
		   raising an error across the whole workspace. */
	}
}
