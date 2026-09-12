import { cell, createStore } from 'segment-state';
import type {
	AccessAttestation,
	AccessChange,
	AccessReview,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus = 'idle' | 'loading' | 'denied' | 'error';

export type ReviewTab = 'members' | 'roles' | 'tokens' | 'providers';

const EMPTY_REVIEW: AccessReview = {
	generatedAt: 0,
	members: [],
	roles: [],
	tokens: [],
	providers: [],
	counts: {
		members: 0,
		activeMembers: 0,
		roles: 0,
		extraScopeGrants: 0,
		tokens: 0,
		providers: 0,
	},
	capped: [],
};

export function createReviewClientState() {
	const store = createStore({
		review: cell<AccessReview>(EMPTY_REVIEW),
		loaded: false,
		status: cell<ScreenStatus>('idle'),
		error: '',
		tab: cell<ReviewTab>('members'),
		query: '',
		attestOpen: false,
		attestBusy: false,
		attestError: '',
		attestNote: '',
		attestFrom: '',
		attestTo: '',
	});
	return { store, state: store.state };
}

export function createActivityClientState() {
	const store = createStore({
		changes: cell<readonly AccessChange[]>([]),
		loaded: false,
		status: cell<ScreenStatus>('idle'),
		error: '',
		kind: cell<'diff' | 'activity'>('diff'),
		from: '',
		to: '',
		cursor: cell<string | null>(null),
		source: '',
	});
	return { store, state: store.state };
}

export function createAttestationsClientState() {
	const store = createStore({
		attestations: cell<readonly AccessAttestation[]>([]),
		loaded: false,
		status: cell<ScreenStatus>('idle'),
		error: '',
		cursor: cell<string | null>(null),
	});
	return { store, state: store.state };
}
