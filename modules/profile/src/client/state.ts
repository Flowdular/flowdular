import { cell, createStore } from 'segment-state';
import type { Profile } from '../domain/types.ts';

export type ProfileClientStatus =
	| 'idle'
	| 'loading'
	| 'saving-profile'
	| 'saving-password';

export function createProfileClientState() {
	const store = createStore({
		profile: cell<Profile | null>(null),
		loaded: false,
		status: cell<ProfileClientStatus>('idle'),
		displayName: '',
		loadError: '',
		profileError: '',
		profileSuccess: '',
		passwordError: '',
		passwordSuccess: '',
	});
	return { store, state: store.state };
}
