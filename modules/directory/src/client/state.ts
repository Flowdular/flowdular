import { cell, createStore } from 'segment-state';
import type {
	ProvisioningEvent,
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimGroupMapping,
	ScimToken,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export type TokenConfirm = 'rotate' | 'revoke';

export function createScimTokensClientState() {
	const store = createStore({
		tokens: cell<readonly ScimToken[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<ScimToken['status'] | ''>(''),
		filtersOpen: false,
		editorOpen: false,
		selectedId: '',
		/** The expiry field's own `YYYY-MM-DDTHH:mm` reading, empty for none. */
		expiresAt: '',
		/* Held only until the drawer closes; the server never returns it again. */
		revealedToken: '',
		confirm: cell<TokenConfirm | null>(null),
	});
	return { store, state: store.state };
}

export function createGroupMappingsClientState() {
	const store = createStore({
		groups: cell<readonly ScimGroupMapping[]>([]),
		roles: cell<readonly string[]>([]),
		defaultRole: '',
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		editorOpen: false,
		selectedId: '',
		roleKey: '',
		precedence: '',
	});
	return { store, state: store.state };
}

export function createProvisioningLogClientState() {
	const store = createStore({
		events: cell<readonly ProvisioningEvent[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		operationFilter: cell<ProvisioningOperation | ''>(''),
		outcomeFilter: cell<ProvisioningOutcome | ''>(''),
		filtersOpen: false,
		/* Null once the server stops handing one back: that is the last page. */
		nextCursor: cell<string | null>(null),
	});
	return { store, state: store.state };
}
