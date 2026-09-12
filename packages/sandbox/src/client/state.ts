import { cell, createStore } from 'segment-state';
import type { GateResult } from '../server/gates.ts';
import type { ChatEntry, SandboxSession } from '../server/sessions.ts';
import type {
	EjectPlanView,
	EjectStep,
	EjectSummary,
	SandboxState,
	SessionView,
} from './api.ts';

export interface PreviewSelection {
	readonly label: string;
	readonly selector: string;
	readonly view: string;
	readonly text: string;
}

/* An attachment upload the composer is still waiting on, kept beside the
   session's committed attachments so its chip shows a pending or error state. */
export interface PendingAttachment {
	readonly key: string;
	readonly name: string;
	readonly kind: 'image' | 'file';
	readonly status: 'uploading' | 'error';
	readonly error?: string;
}

/* A refused answer submission, stamped with the session and the question set it
   answered, so it can never be shown beside another form. */
export interface AnswersRefusal {
	readonly session: string;
	readonly sequence: number;
	readonly message: string;
}

/* A refusal outlives the record it answered, because a submission that already
   consumed the questions still has to say why it failed. It does not outlive
   the session it was refused in, nor a newer question set. */
export function answersErrorFor(
	refusal: AnswersRefusal | null,
	sessionId: string,
	pending: { readonly sequence: number } | null,
): string {
	if (!refusal || refusal.session !== sessionId) return '';
	if (pending && pending.sequence > refusal.sequence) return '';
	return refusal.message;
}

export function createSandboxClientState() {
	const store = createStore({
		state: cell<SandboxState | null>(null),
		view: cell<SessionView | null>(null),
		sessions: cell<readonly SandboxSession[]>([]),
		liveEntries: cell<readonly ChatEntry[]>([]),
		selection: cell<PreviewSelection | null>(null),
		ejectPlan: cell<EjectPlanView | null>(null),
		ejectSteps: cell<readonly EjectStep[]>([]),
		ejectSummary: cell<EjectSummary | null>(null),
		ejectError: '',
		ejecting: false,
		ejectBuild: false,
		menuOpen: false,
		githubSettingsOpen: false,
		gateResults: cell<readonly GateResult[]>([]),
		gatesOpen: false,
		gatesRunning: false,
		gatesError: '',
		connecting: false,
		activeSessionId: '',
		role: 'auto',
		/* Which module the panes show; empty means every module of the session. */
		activeModule: '',
		/* Which module the next turn targets; empty means the planner decides. */
		turnModule: '',
		driver: '',
		message: '',
		workbench: cell<'none' | 'preview' | 'diff' | 'spec'>('none'),
		cardMode: cell<'preview' | 'code'>('preview'),
		previewNonce: 0,
		selecting: false,
		running: false,
		busy: false,
		error: '',
		notice: '',
		/* Session list controls: which card's menu is open, which delete waits
		   for confirmation, and whether archived sessions are shown. */
		sessionMenu: '',
		confirmDelete: '',
		showArchived: false,
	});
	return { store, state: store.state };
}

export type SandboxClientState = ReturnType<typeof createSandboxClientState>;

export function sessionIdFromUrl(pathname: string): string {
	const segments = pathname.split('/').filter(Boolean);
	return segments[0] === 'sessions' ? (segments[1] ?? '') : '';
}

export function mergeSteps(
	steps: readonly EjectStep[],
	step: EjectStep,
): readonly EjectStep[] {
	const index = steps.findIndex((candidate) => candidate.id === step.id);
	if (index < 0) return [...steps, step];
	return steps.map((candidate, position) =>
		position === index ? step : candidate,
	);
}

export function mergeEntries(
	existing: readonly ChatEntry[],
	incoming: readonly ChatEntry[],
): readonly ChatEntry[] {
	const seen = new Set(existing.map((entry) => entry.sequence));
	return [
		...existing,
		...incoming.filter((entry) => !seen.has(entry.sequence)),
	];
}

/* The splash in index.html waits for this signal, so the first paint is the
   brand block and never a flash of unstyled text. */
export function signalReady(): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new Event('flowdular:ready'));
}
