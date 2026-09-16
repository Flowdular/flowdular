import { cell, createStore } from 'segment-state';
import type { ResearchEvidenceDetail } from '../domain/types.ts';
import type {
	ResearchAttemptRow,
	ResearchEvidenceRow,
	ResearchQueryRow,
} from './api.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus = 'idle' | 'loading' | 'denied' | 'error';

export type ResearchTab = 'evidence' | 'queries' | 'adapters';

export function createResearchClientState(initialTab: ResearchTab) {
	const store = createStore({
		tab: cell<ResearchTab>(initialTab),
		evidence: cell<readonly ResearchEvidenceRow[]>([]),
		evidenceCursor: cell<string | null>(null),
		evidenceLoaded: false,
		queries: cell<readonly ResearchQueryRow[]>([]),
		queriesCursor: cell<string | null>(null),
		queriesLoaded: false,
		status: cell<ScreenStatus>('idle'),
		error: '',
		selectedId: cell<string | null>(null),
		detail: cell<ResearchEvidenceDetail | null>(null),
		detailStatus: cell<'idle' | 'loading' | 'error'>('idle'),
		detailError: '',
		attemptsQuery: cell<ResearchQueryRow | null>(null),
		attempts: cell<readonly ResearchAttemptRow[]>([]),
		attemptsStatus: cell<'idle' | 'loading' | 'error'>('idle'),
		attemptsError: '',
		adaptersReload: 0,
	});
	return { store, state: store.state };
}
