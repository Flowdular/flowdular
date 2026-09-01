import { cell, createStore } from 'segment-state';
import type { CatalogItem } from '../domain/types.ts';

export function createCatalogClientState() {
	const store = createStore({
		items: cell<readonly CatalogItem[]>([]),
		query: '',
		formOpen: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		formSession: 0,
	});
	return { store, state: store.state };
}
