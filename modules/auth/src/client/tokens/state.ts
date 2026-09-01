import { cell, createStore } from 'segment-state';
import type { ApiTokenRecord } from '../../domain/types.ts';

export function createApiTokenClientState() {
	const store = createStore({
		tokens: cell<readonly ApiTokenRecord[]>([]),
		availableScopes: cell<readonly string[]>([]),
		issuedToken: '',
		issuedLabel: '',
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		query: '',
		formOpen: false,
		formSession: 0,
	});
	return { store, state: store.state };
}

export function tokenState(
	token: ApiTokenRecord,
	now: number,
): 'active' | 'expired' | 'revoked' {
	if (token.revokedAt !== null) return 'revoked';
	if (token.expiresAt !== null && token.expiresAt <= now) return 'expired';
	return 'active';
}
