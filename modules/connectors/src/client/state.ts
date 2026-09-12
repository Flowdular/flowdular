import { cell, createStore } from 'segment-state';
import type {
	ConnectorCall,
	ConnectorCallOutcome,
	ConnectorDefinition,
	ConnectorInstance,
	ConnectorInstanceStatus,
} from '../domain/types.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

/** What a test call reported, held only while the drawer is open. */
export interface TestCallReport {
	readonly outcome: ConnectorCallOutcome;
	readonly status: number | null;
	readonly errorClass: string | null;
	readonly durationMs: number;
	readonly bodyPreview: string;
}

/**
 * Which manage action is waiting for its confirmation dialog. Consent is one
 * entry per caller kind: a dialog that moved both at once could not state the
 * value it was about to write.
 */
export type ConnectorConfirm =
	| 'disable'
	| 'delete'
	| 'consent-workflows'
	| 'consent-agents';

export function createConnectorsClientState() {
	const store = createStore({
		instances: cell<readonly ConnectorInstance[]>([]),
		definitions: cell<readonly ConnectorDefinition[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		statusFilter: cell<ConnectorInstanceStatus | ''>(''),
		definitionFilter: '',
		filtersOpen: false,
		editorOpen: false,
		selectedId: '',
		formSession: 0,
		test: cell<TestCallReport | null>(null),
		confirm: cell<ConnectorConfirm | null>(null),
	});
	return { store, state: store.state };
}

export function createConnectorCallsClientState() {
	const store = createStore({
		calls: cell<readonly ConnectorCall[]>([]),
		instances: cell<readonly ConnectorInstance[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		outcomeFilter: cell<ConnectorCallOutcome | ''>(''),
		instanceFilter: '',
		filtersOpen: false,
	});
	return { store, state: store.state };
}
