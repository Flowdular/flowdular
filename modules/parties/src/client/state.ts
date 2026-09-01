import { cell, createStore } from 'segment-state';
import type { Party } from '../domain/types.ts';

export function createPartiesClientState() {
	const store = createStore({
		parties: cell<readonly Party[]>([]),
		query: '',
		formOpen: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}
