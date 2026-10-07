import type { SandboxSession } from './sessions.ts';
import { SandboxSetupError } from './workspace-root.ts';

/* Change notifications for the open views of one session, so a tab follows
   what another tab or browser did to it. A notification carries no state: the
   watcher reloads through the authorized read routes. Session ids are random
   UUIDs, so they key the registry without the workspace root. */
export type SessionWatcher = () => void;

/* Each watcher is one open event stream. The cap keeps a runaway client from
   growing the registry; past it a new stream is refused, never an old one
   evicted. */
export const MAX_SESSION_WATCHERS = 32;

const SLOT = Symbol.for('flowdular.sandbox.session-watchers');
type Watchers = Map<string, Set<SessionWatcher>>;

/** Route HMR replaces closures, not the streams those closures opened. */
function registry(): Watchers {
	const state = globalThis as unknown as Record<symbol, Watchers | undefined>;
	return (state[SLOT] ??= new Map());
}

export function watchSession(
	sessionId: string,
	watcher: SessionWatcher,
): () => void {
	const watchers = registry();
	let set = watchers.get(sessionId);
	if (!set) {
		set = new Set();
		watchers.set(sessionId, set);
	}
	if (set.size >= MAX_SESSION_WATCHERS) {
		throw new SandboxSetupError(
			'SESSION_WATCHERS_EXHAUSTED',
			'Too many views follow this session. Close a tab and reload.',
		);
	}
	set.add(watcher);
	return () => {
		set.delete(watcher);
		if (set.size === 0 && watchers.get(sessionId) === set) {
			watchers.delete(sessionId);
		}
	};
}

/* A running chain's turn stream carries every record its session writes, so
   the view it feeds shows the state the session is in. In process only, one
   per running chain, so it is not bounded like the views. */
export type SessionRecordListener = (session: SandboxSession) => void;

const RECORD_SLOT = Symbol.for('flowdular.sandbox.session-records');
type RecordListeners = Map<string, Set<SessionRecordListener>>;

export function followSessionRecords(
	sessionId: string,
	listener: SessionRecordListener,
): () => void {
	const state = globalThis as unknown as Record<
		symbol,
		RecordListeners | undefined
	>;
	const listeners = (state[RECORD_SLOT] ??= new Map());
	let set = listeners.get(sessionId);
	if (!set) {
		set = new Set();
		listeners.set(sessionId, set);
	}
	set.add(listener);
	return () => {
		set.delete(listener);
		if (set.size === 0 && listeners.get(sessionId) === set) {
			listeners.delete(sessionId);
		}
	};
}

/* Called on every record write, with the record, and on every transcript
   append, so a session nobody watches costs two map lookups. */
export function notifySessionChanged(
	sessionId: string,
	record?: SandboxSession,
): void {
	if (record) {
		const listeners = (
			globalThis as unknown as Record<symbol, RecordListeners | undefined>
		)[RECORD_SLOT]?.get(sessionId);
		for (const listener of listeners ?? []) {
			try {
				listener(record);
			} catch {
				/* Isolated like a watcher. */
			}
		}
	}
	const watchers = (
		globalThis as unknown as Record<symbol, Watchers | undefined>
	)[SLOT]?.get(sessionId);
	if (!watchers) return;
	for (const watcher of watchers) {
		/* A watcher writes to one client connection; its failure must never
		   reach the writer that changed the session or the other watchers. Its
		   stream removes it when the connection closes. */
		try {
			watcher();
		} catch {
			/* Isolated by contract. */
		}
	}
}
