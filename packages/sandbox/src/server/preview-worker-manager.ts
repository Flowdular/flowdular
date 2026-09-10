import { sandboxDirectory } from './config.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewDatabaseProvider } from './preview-database.ts';
import {
	createPreviewDatabaseHost,
	type PreviewDatabaseHost,
} from './preview-database-host.ts';
import type { PreviewComposition, PreviewRuntime } from './preview-runtime.ts';
import type { SandboxSession } from './sessions.ts';
import { resolvePreviewModules } from './preview-modules.ts';
import { previewRevision } from './preview-revision.ts';
import { sendPreviewDatabaseReply } from './preview-ipc.ts';

const START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface IsolatedPreviewOptions {
	readonly startTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	/* Diagnostics must not retain the child. Tests use this to prove that
	   concurrent first requests share one worker. */
	readonly onWorkerLifecycle?: (
		event: 'started' | 'released',
		sessionId: string,
	) => void;
}

interface WorkerReady {
	readonly type: 'ready';
	readonly port: number;
}

interface WorkerFailure {
	readonly type: 'error';
	readonly message: string;
}

interface PreviewMeta {
	readonly sessionId: string;
	readonly revision: string;
	readonly moduleId: string;
	readonly modules: PreviewComposition['modules'];
	readonly credentials: PreviewComposition['credentials'];
	readonly moduleScopes: PreviewComposition['moduleScopes'];
	readonly error: string | null;
	readonly routes: number;
}

interface IsolatedWorker {
	readonly child: ChildProcess;
	readonly origin: string;
}

interface WorkerSlot {
	readonly revision: string;
	readonly keys: PreviewKeys;
	readonly child: ChildProcess;
	readonly host: PreviewDatabaseHost;
	readonly ready: Promise<IsolatedWorker>;
}

interface PreviewKeys {
	readonly FD_AGENT_CREDENTIAL_KEY: string;
	readonly FD_AGENT_RUN_GRANT_KEY: string;
}

function timeoutSignal(timeoutMs: number): {
	readonly signal: AbortSignal;
	readonly clear: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/* The worker answers on its own loopback port, so a browser request crossing
   into it carries an origin that names the sandbox server, not the worker. A
   draft module's authentication routes compare the Origin header with the URL
   they were reached on and would reject every call. The sandbox checked the
   browser origin before this hop, so the hop presents its own. Referer names
   the sandbox page for the same reason and is dropped; the session travels in
   x-flowdular-preview-session. */
export function previewHopHeaders(
	source: Headers,
	workerOrigin: string,
): Headers {
	const headers = new Headers(source);
	headers.delete('host');
	headers.delete('connection');
	headers.delete('content-length');
	headers.delete('referer');
	if (headers.has('origin')) headers.set('origin', workerOrigin);
	return headers;
}

async function requestWorker(
	worker: IsolatedWorker,
	path: string,
	request: Request,
	timeoutMs: number,
): Promise<Response> {
	const timeout = timeoutSignal(timeoutMs);
	try {
		const headers = previewHopHeaders(request.headers, worker.origin);
		const method = request.method.toUpperCase();
		const body =
			method === 'GET' || method === 'HEAD'
				? undefined
				: await request.arrayBuffer();
		return await fetch(new URL(path, worker.origin), {
			method,
			headers,
			...(body ? { body } : {}),
			signal: timeout.signal,
		});
	} finally {
		timeout.clear();
	}
}

function startWorker(
	workspaceRoot: string,
	session: SandboxSession,
	revision: string,
	startTimeoutMs: number,
	/* The previous worker's engine holds the same data directory until it has
	   closed, and two embedded PostgreSQL instances must never share one. */
	drained: Promise<void> | undefined,
	/* Source reloads keep the session's vault and retained grants readable. */
	keys: PreviewKeys = {
		FD_AGENT_CREDENTIAL_KEY: randomBytes(32).toString('base64'),
		FD_AGENT_RUN_GRANT_KEY: randomBytes(32).toString('base64'),
	},
): WorkerSlot {
	/* Permission roots must be physical paths. On macOS /var is a symlink to
	   /private/var; granting the lexical path still makes Node deny the realpath
	   lookup before the worker reaches the session. */
	const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
	const entry = fileURLToPath(new URL('./preview-worker.ts', import.meta.url));
	const repositoryRoot = resolve(dirname(entry), '../../../..');
	const sessionRoot = join(
		sandboxDirectory(canonicalWorkspaceRoot),
		'sessions',
		session.id,
	);
	const readable = [
		sessionRoot,
		join(repositoryRoot, 'packages'),
		join(repositoryRoot, 'modules'),
		join(repositoryRoot, 'node_modules'),
	];
	const writable = [
		/* Authentication and module databases are the only persistent state a
		   preview composition owns. Session metadata, chat, source, checkpoints
		   and attachments stay read-only even to draft top-level code. */
		join(sessionRoot, 'data'),
		join(sessionRoot, '.flowdular'),
	];
	for (const path of writable)
		mkdirSync(path, { recursive: true, mode: 0o700 });
	/* The preview gets only a tiny, explicit environment. In particular it
	   cannot inherit platform, BYOK or GitHub credentials from the sandbox. */
	const child = spawn(
		process.execPath,
		[
			/* Native transformation avoids tsx, whose loader starts an esbuild
			   child process and would force us to grant draft code that capability. */
			'--experimental-transform-types',
			'--permission',
			...readable.map((path) => `--allow-fs-read=${path}`),
			...writable.map((path) => `--allow-fs-write=${path}`),
			entry,
			canonicalWorkspaceRoot,
		],
		{
			cwd: canonicalWorkspaceRoot,
			env: {
				NODE_ENV: process.env.NODE_ENV === 'test' ? 'test' : 'production',
				// Ephemeral keys belong only to this isolated preview runtime.
				...keys,
				FD_INTERNAL_SANDBOX_PREVIEW_WORKER: '1',
				FD_INTERNAL_SANDBOX_STATE_ROOT:
					sandboxDirectory(canonicalWorkspaceRoot) ===
					join(canonicalWorkspaceRoot, '.coreloom', 'sandbox')
						? '.coreloom'
						: '.flowdular',
			},
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			/* Database rows carry bigints, byte arrays and dates, none of which
			   survive the default JSON channel. */
			serialization: 'advanced',
		},
	);
	/* The worker cannot host the engine: Node's permission model denies
	   process.binding, which the embedded PostgreSQL build needs during static
	   init. The engine stays here and the worker drives it over this channel. */
	const host = createPreviewDatabaseHost({
		open: async () => {
			await drained;
			return createPreviewDatabaseProvider(join(sessionRoot, 'data'));
		},
		send: (reply) => sendPreviewDatabaseReply(child, reply),
	});
	child.on('message', (message) => {
		host.accept(message);
	});
	const closeHost = () => void host.close().catch(() => undefined);
	child.once('exit', closeHost);
	child.once('disconnect', closeHost);
	const ready = new Promise<IsolatedWorker>((resolvePromise, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback();
		};
		const timer = setTimeout(
			() =>
				finish(() => {
					child.kill('SIGKILL');
					reject(
						new Error('The isolated preview worker did not start in time.'),
					);
				}),
			startTimeoutMs,
		);
		timer.unref();
		child.on('message', (message: WorkerReady | WorkerFailure) => {
			if (message?.type === 'ready' && Number.isInteger(message.port)) {
				finish(() =>
					resolvePromise({ child, origin: `http://127.0.0.1:${message.port}` }),
				);
			}
			if (message?.type === 'error') {
				finish(() => reject(new Error(message.message)));
			}
		});
		child.once('error', (error) => finish(() => reject(error)));
		child.once('exit', (code, signal) =>
			finish(() =>
				reject(
					new Error(
						`The isolated preview worker stopped before it was ready (${signal ?? code ?? 'unknown'}).`,
					),
				),
			),
		);
	});
	return { child, host, ready, revision, keys };
}

/* The manager owns process lifetime. A worker crash or timeout destroys only
   that preview. The sandbox keeps serving sessions, bridge requests and turns. */
export function createIsolatedPreviewRuntime(
	workspaceRoot: string,
	options: IsolatedPreviewOptions = {},
): PreviewRuntime {
	const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const workers = new Map<string, WorkerSlot>();
	const cached = new Map<string, PreviewComposition>();
	const composing = new Map<
		string,
		{ pending: Promise<PreviewComposition>; controller: AbortController }
	>();
	/* Self-clearing: an entry lives only until the engine it names has closed. */
	const draining = new Map<string, Promise<void>>();
	let disposed = false;
	const observe = (event: 'started' | 'released', sessionId: string) => {
		try {
			options.onWorkerLifecycle?.(event, sessionId);
		} catch {
			/* Diagnostics never own or interrupt the worker lifecycle. */
		}
	};
	const release = (sessionId: string, expected?: WorkerSlot) => {
		const slot = workers.get(sessionId);
		if (!slot || (expected && slot !== expected))
			return draining.get(sessionId) ?? Promise.resolve();
		workers.delete(sessionId);
		cached.delete(sessionId);
		const drained = slot.host.close().catch(() => undefined);
		draining.set(sessionId, drained);
		void drained.then(() => {
			if (draining.get(sessionId) === drained) draining.delete(sessionId);
		});
		slot.child.kill('SIGKILL');
		observe('released', sessionId);
		return drained;
	};
	const compose = async (session: SandboxSession, signal: AbortSignal) => {
		const revision = await previewRevision(
			await resolvePreviewModules(workspaceRoot, session),
		);
		signal.throwIfAborted();
		let slot = workers.get(session.id);
		const keys = slot?.keys;
		if (
			slot &&
			(slot.revision !== revision ||
				slot.child.exitCode !== null ||
				slot.child.killed)
		) {
			release(session.id, slot);
			slot = undefined;
		}
		if (!slot) {
			slot = startWorker(
				workspaceRoot,
				session,
				revision,
				startTimeoutMs,
				draining.get(session.id),
				keys,
			);
			workers.set(session.id, slot);
			observe('started', session.id);
			const owned = slot;
			owned.child.once('exit', () => {
				if (workers.get(session.id) === owned) release(session.id, owned);
			});
		}
		let worker: IsolatedWorker;
		try {
			worker = await slot.ready;
			signal.throwIfAborted();
		} catch (error) {
			release(session.id, slot);
			throw error;
		}
		let response: Response;
		try {
			response = await requestWorker(
				worker,
				'/compose',
				new Request('http://preview/compose', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(session),
				}),
				requestTimeoutMs,
			);
		} catch (error) {
			release(session.id, slot);
			throw error;
		}
		if (!response.ok) {
			release(session.id, slot);
			const detail = await response.text().catch(() => '');
			throw new Error(
				`The isolated preview worker could not compose the draft.${
					detail ? ` ${detail.slice(0, 500)}` : ''
				}`,
			);
		}
		const meta = (await response.json()) as PreviewMeta;
		signal.throwIfAborted();
		const current = cached.get(session.id);
		if (current && current.revision === meta.revision) return current;
		const owned = slot;
		const composition: PreviewComposition = {
			...meta,
			auth: null as never,
			router: null as never,
			routes: Array.from({ length: meta.routes }, () => null as never),
			request: async (request) => {
				try {
					const forwarded = new Request(request, {
						headers: new Headers(request.headers),
					});
					forwarded.headers.set('x-flowdular-preview-session', session.id);
					return await requestWorker(
						worker,
						`/request${new URL(request.url).pathname}${new URL(request.url).search}`,
						forwarded,
						requestTimeoutMs,
					);
				} catch {
					release(session.id, owned);
					return Response.json(
						{
							error: {
								code: 'PREVIEW_WORKER_UNAVAILABLE',
								message:
									'The isolated preview stopped. Reload the preview to start a new one.',
							},
						},
						{ status: 503 },
					);
				}
			},
			dispose: () => release(session.id, owned),
		};
		cached.set(session.id, composition);
		return composition;
	};
	return {
		cached: (sessionId) => cached.get(sessionId) ?? null,
		forget: (sessionId) => {
			composing.get(sessionId)?.controller.abort();
			composing.delete(sessionId);
			return release(sessionId);
		},
		dispose: () => {
			disposed = true;
			for (const entry of composing.values()) entry.controller.abort();
			for (const sessionId of [...workers.keys()]) release(sessionId);
			cached.clear();
			composing.clear();
		},
		compose: (session: SandboxSession) => {
			if (disposed) {
				return Promise.reject(
					new Error('The isolated preview runtime was already disposed.'),
				);
			}
			const active = composing.get(session.id);
			if (active) return active.pending;
			const controller = new AbortController();
			const pending = compose(session, controller.signal);
			const entry = { pending, controller };
			composing.set(session.id, entry);
			const clear = () => {
				if (composing.get(session.id) === entry) composing.delete(session.id);
			};
			void pending.then(clear, clear);
			return pending;
		},
	};
}
