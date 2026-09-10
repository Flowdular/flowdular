import { cell, createStore } from 'segment-state';
import type { Note } from '../domain/types.ts';

export function createExampleClientState() {
	const store = createStore({
		notes: cell<readonly Note[]>([]),
		query: '',
		formOpen: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		formSession: 0,
	});
	return { store, state: store.state };
}
