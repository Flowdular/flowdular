import { cell, createStore } from 'segment-state';
import type {
	SandboxAccessCandidate,
	SandboxAccessGrant,
	SandboxSessionRecord,
} from '../domain/types.ts';

export function createSandboxClientState() {
	const store = createStore({
		grants: cell<readonly SandboxAccessGrant[]>([]),
		candidates: cell<readonly SandboxAccessCandidate[]>([]),
		sessions: cell<readonly SandboxSessionRecord[]>([]),
		sandboxUrl: '',
		selectedAccountId: '',
		formOpen: false,
		status: cell<'idle' | 'loading' | 'submitting'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}
