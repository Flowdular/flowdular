import { createHash, timingSafeEqual } from 'node:crypto';
import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	serverLogger,
	type ModuleServerComposition,
} from '@flowdular/server';
import type { PlatformRuntimeLifecycle } from './lifecycle.ts';

export const WORKER_TICK_PATH = '/api/internal/worker/tick';
const DEFAULT_WINDOW_MS = 50_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 240_000;
const MIN_SECRET_LENGTH = 32;
/* A request that just queued work asks for a short window: long enough for the
   first passes to claim it, short enough that a burst of requests is not held
   behind one long drain. */
const KICK_WINDOW_MS = 15_000;

export interface WorkerTickConfig {
	readonly secret: string;
	readonly windowMs: number;
}

export function workerTickConfigFromEnvironment(
	environment: NodeJS.ProcessEnv,
): WorkerTickConfig {
	const secret = environment.FD_WORKER_TICK_SECRET?.trim() ?? '';
	if (secret.length < MIN_SECRET_LENGTH) {
		throw new Error(
			`FD_WORKER_TICK_SECRET must hold at least ${MIN_SECRET_LENGTH} characters in the tick role.`,
		);
	}
	const configured = environment.FD_WORKER_TICK_WINDOW_MS?.trim();
	const windowMs = configured ? Number(configured) : DEFAULT_WINDOW_MS;
	if (
		!Number.isSafeInteger(windowMs) ||
		windowMs < MIN_WINDOW_MS ||
		windowMs > MAX_WINDOW_MS
	) {
		throw new Error(
			`FD_WORKER_TICK_WINDOW_MS must be an integer between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS}.`,
		);
	}
	return { secret, windowMs };
}

export interface WorkerTickReport {
	readonly status: 'drained' | 'closed';
	readonly joined: boolean;
	readonly windowMs: number;
	readonly durationMs: number;
}

export interface WorkerTicker {
	/** Runs the module workers for one window, then drains them. A tick that
	 *  arrives while a window is open joins it instead of starting another. */
	tick(windowMs?: number): Promise<WorkerTickReport>;
	/** Ends an open window early and waits for its drain; later ticks run nothing. */
	close(): Promise<void>;
}

export function createWorkerTicker(
	compositions: readonly ModuleServerComposition[],
	options: { readonly windowMs: number; readonly now?: () => number },
): WorkerTicker {
	const now = options.now ?? Date.now;
	let current: Promise<WorkerTickReport> | undefined;
	let closed = false;
	let endWindow: (() => void) | undefined;

	const run = async (windowMs: number): Promise<WorkerTickReport> => {
		const startedAt = now();
		const started: ModuleServerComposition[] = [];
		let failure: unknown;
		try {
			for (const composition of compositions) {
				if (!composition.startWorker || closed) continue;
				/* Recorded before the await: a worker that failed halfway through
				   its start may still hold a timer, and its stop releases it. */
				started.push(composition);
				await composition.startWorker();
			}
			if (!closed) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, windowMs);
					endWindow = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
		} catch (error) {
			failure = error;
		} finally {
			endWindow = undefined;
		}
		/* Drained before the request answers: the host may freeze the instance
		   as soon as the response leaves, and a frozen claim waits out its lease. */
		for (const composition of started.reverse()) {
			try {
				await composition.stop?.();
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) throw failure;
		return {
			status: closed ? 'closed' : 'drained',
			joined: false,
			windowMs,
			durationMs: now() - startedAt,
		};
	};

	return {
		tick(windowMs = options.windowMs) {
			if (current) {
				return current.then((report) => ({ ...report, joined: true }));
			}
			if (closed) {
				return Promise.resolve({
					status: 'closed',
					joined: false,
					windowMs,
					durationMs: 0,
				});
			}
			const pending = run(windowMs).finally(() => {
				if (current === pending) current = undefined;
			});
			current = pending;
			return pending;
		},
		async close() {
			closed = true;
			endWindow?.();
			await current?.catch(() => undefined);
		},
	};
}

/* An open window holds its tick request, and retirement waits for requests
   before any quiesce runs, so the window closes as soon as retirement begins
   and the module stops then run again. */
export function closeWorkerTickerOnRetirement(
	lifecycle: Pick<PlatformRuntimeLifecycle, 'addInterrupt'>,
	ticker: WorkerTicker,
): void {
	lifecycle.addInterrupt(() => ticker.close());
}

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

export function createWorkerTickEndpoint(
	ticker: WorkerTicker,
	config: WorkerTickConfig,
) {
	const expected = digest(config.secret);
	const kickWindowMs = Math.min(KICK_WINDOW_MS, config.windowMs);
	return defineEndpoint({
		id: 'system.worker-tick',
		path: WORKER_TICK_PATH,
		/* GET is what a scheduler such as Vercel Cron sends; POST is a request
		   path asking for a pass after it queued work. */
		methods: ['GET', 'POST'],
		access: { kind: 'public' },
		handler: async ({ octane }) => {
			const header = octane.request.headers.get('authorization') ?? '';
			const presented = /^Bearer (.+)$/i.exec(header)?.[1]?.trim() ?? '';
			if (!timingSafeEqual(digest(presented), expected)) {
				return problemResponse(
					new HttpProblem(
						'UNAUTHENTICATED',
						'Authentication is required.',
						401,
					),
				);
			}
			try {
				const report = await ticker.tick(
					octane.request.method === 'POST' ? kickWindowMs : config.windowMs,
				);
				return jsonResponse(report, report.status === 'closed' ? 503 : 200);
			} catch (error) {
				serverLogger().error('worker tick failed', {
					module: 'platform',
					err: error,
				});
				return problemResponse(
					new HttpProblem(
						'WORKER_TICK_FAILED',
						'The worker tick did not complete.',
						500,
					),
				);
			}
		},
	});
}
