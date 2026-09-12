import { cell, createStore } from 'segment-state';
import type { IdentityProviderSummary } from '../../domain/types.ts';
import { AuthClientApiError } from '../api.ts';

/**
 * Whether a failed read is a refusal rather than a fault. 401 means the session
 * went away and 403 means the scope is missing; both are the denied screen.
 * Anything else, a server fault or a network that was not there, is a read that
 * can succeed on the next try, so the screen keeps the error and a retry.
 */
export function providerReadDenied(error: unknown): boolean {
	return (
		error instanceof AuthClientApiError &&
		(error.status === 401 || error.status === 403)
	);
}

export function createIdentityProviderClientState() {
	const store = createStore({
		providers: cell<readonly IdentityProviderSummary[]>([]),
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
		notice: '',
		/** The read scope is missing or the read was refused. */
		denied: false,
		query: '',
		/** The open record, or the empty string while the drawer is closed. */
		selectedId: '',
		creating: false,
		/* Bumped on every open so the form remounts empty: a secret typed once
		   must never survive into the next record. */
		formSession: 0,
	});
	return { store, state: store.state };
}
