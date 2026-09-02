import { cell, createStore } from 'segment-state';
import type { HistoryEntry } from '@coreloom/kernel';
import type { Party } from '../domain/types.ts';

export function createPartiesClientState() {
	const store = createStore({
		parties: cell<readonly Party[]>([]),
		query: '',
		vatIdOnly: false,
		includeArchived: false,
		formOpen: false,
		deleteConfirmOpen: false,
		editingParty: cell<Party | null>(null),
		historyOpen: false,
		historyParty: cell<Party | null>(null),
		historyEntries: cell<readonly HistoryEntry[]>([]),
		historyLoading: false,
		historyError: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		formSession: 0,
	});
	return { store, state: store.state };
}
