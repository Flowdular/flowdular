import { cell, createStore } from 'segment-state';
import type { HistoryEntry } from '@flowdular/sdk/kernel';
import type { CatalogItem } from '../domain/types.ts';

export function createCatalogClientState() {
	const store = createStore({
		items: cell<readonly CatalogItem[]>([]),
		query: '',
		includeArchived: false,
		filtersOpen: false,
		formOpen: false,
		deleteConfirmOpen: false,
		editingItem: cell<CatalogItem | null>(null),
		historyOpen: false,
		historyItem: cell<CatalogItem | null>(null),
		historyEntries: cell<readonly HistoryEntry[]>([]),
		historyLoading: false,
		historyError: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		formSession: 0,
	});
	return { store, state: store.state };
}
