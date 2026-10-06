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

/* Called on every record write and transcript append, so a session nobody
   watches costs one map lookup. */
export function notifySessionChanged(sessionId: string): void {
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
