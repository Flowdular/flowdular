import type { Logger } from '../log.ts';

/**
 * The stable code a runner reports when the fence says the claim changed hands.
 * It is the reason carried by the aborted signal, so a stage that stops on it
 * settles nothing: the work belongs to whoever holds the claim now.
 */
export const JOB_CLAIM_LOST = 'CLAIM_LOST';

export class JobClaimLostError extends Error {
	readonly code = JOB_CLAIM_LOST;
	constructor(readonly job: string) {
		super(`Another process took over the work ${job} had claimed.`);
		this.name = 'JobClaimLostError';
	}
}

export interface JobBackoff {
	readonly initialMs: number;
	readonly maxMs: number;
	readonly multiplier: number;
}

/** What one pass did. Every item is counted in exactly one of the three. */
export interface JobPassReport {
	readonly claimed: number;
	readonly performed: number;
	readonly failed: number;
	readonly claimLost: number;
}

/**
 * The trace a pass emits. Identities and timings only: a consumer that wants
 * the work itself reads the module's own tables through the id it already has.
 *
 * A pass that claimed nothing emits neither `pass-start` nor `pass-end`: a loop
 * polling an empty queue all day is not work, and a span each would fill the
 * ring a real pass has to share.
 */
export type JobEvent =
	| { readonly type: 'pass-start'; readonly name: string; readonly at: number }
	| {
			readonly type: 'pass-end';
			readonly name: string;
			readonly at: number;
			readonly report: JobPassReport;
			readonly nextDelayMs: number;
	  }
	| { readonly type: 'claimed'; readonly name: string; readonly at: number }
	| {
			readonly type: 'claim-failed';
			readonly name: string;
			readonly at: number;
			readonly error: unknown;
	  }
	| {
			readonly type: 'performed';
			readonly name: string;
			readonly at: number;
			readonly durationMs: number;
	  }
	| {
			readonly type: 'item-failed';
			readonly name: string;
			readonly at: number;
			readonly error: unknown;
	  }
	| { readonly type: 'heartbeat'; readonly name: string; readonly at: number }
	| {
			readonly type: 'heartbeat-failed';
			readonly name: string;
			readonly at: number;
			readonly error: unknown;
	  }
	| { readonly type: 'claim-lost'; readonly name: string; readonly at: number };

export interface JobRunnerOptions<Claimed> {
	/**
	 * Stable id of this loop, conventionally the module id or
	 * `<module id>.<loop>` when a module runs more than one. It is the `module`
	 * field of every line the runner logs and the `name` on every event.
	 */
	readonly name: string;
	readonly intervalMs: number;
	/**
	 * One claim attempt at `at`. Null ends the pass: nothing is waiting, or
	 * nothing waiting could be taken. The runner opens no database handle, so the
	 * table, the statement and the stale window stay the module's own; the module
	 * computes its stale cutoff from the same `staleAfterMs` it passes here.
	 */
	readonly claim: (at: number) => Promise<Claimed | null>;
	/**
	 * The work for one claimed item. It is aborted through `signal` when the
	 * fence below says the claim changed hands, and a stage that observes the
	 * abort must stop without settling the item.
	 */
	readonly perform: (claimed: Claimed, signal: AbortSignal) => Promise<void>;
	/**
	 * Renews the claim, answering whether the renewal landed. False means the
	 * lease lapsed and another process reclaimed the item. A renewal the database
	 * could not answer at all is not a lost claim: it throws, the lease is
	 * unchanged, and the next beat asks again.
	 */
	readonly heartbeat?:
		| ((claimed: Claimed, at: number) => Promise<boolean>)
		| undefined;
	/** Defaults to a third of `staleAfterMs`, so two renewals fit in the window. */
	readonly heartbeatEveryMs?: number | undefined;
	/** How long a claim survives without a renewal. */
	readonly staleAfterMs: number;
	/** Absent means none: a failing pass waits the same `intervalMs` as any other. */
	readonly backoff?: JobBackoff | undefined;
	/** Claims one pass may take. Defaults to `DEFAULT_JOB_BATCH_LIMIT`. */
	readonly batchLimit?: number | undefined;
	/**
	 * Items one pass performs at the same time, each under its own heartbeat
	 * timer and its own abort signal. Defaults to 1, which claims and performs in
	 * strict alternation. Bounded to 1 up to 64; a value outside that, or one
	 * that is not a whole count, is the default. Claims stay serialized at every
	 * setting: the claim statement, its page and its stale window are the
	 * module's, written for one caller at a time.
	 */
	readonly concurrency?: number | undefined;
	readonly logger: () => Logger;
	readonly now?: (() => number) | undefined;
	/** Trace hook for observability. Isolated: a throwing sink costs the pass nothing. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
}

export interface JobRunner {
	readonly name: string;
	/** Starts the loop with an immediate first pass. */
	start(): void;
	/** One pass. Answers the pass already in flight rather than overlapping it. */
	tick(): Promise<JobPassReport>;
	/**
	 * Asks for a pass that can see work enqueued now. Idle, that is one pass. With
	 * a pass in flight it is one follow-up pass once that pass ends, because a
	 * pass that already found its source empty will not look again: every wake
	 * arriving during the same pass coalesces into that single follow-up.
	 */
	wake(): void;
	stop(): void;
	/** Stops the loop and waits for the pass in flight. Restartable. */
	quiesce(): Promise<void>;
	/** Quiesces for good: every later `start` and `tick` is a no-op. */
	dispose(): Promise<void>;
}

export const DEFAULT_JOB_BATCH_LIMIT = 25;

/* The ceiling on `concurrency`. A loop that needs more parallelism than this
   needs more processes, not a deeper pool over one connection budget. */
const MAX_JOB_CONCURRENCY = 64;

const HEARTBEAT_DIVISOR = 3;
const MIN_HEARTBEAT_MS = 250;
/* Bounds both the exponent and the counter behind it, so a loop that has been
   failing for a week computes the same delay as one failing for an hour. */
const MAX_BACKOFF_DOUBLINGS = 30;

const IDLE: JobPassReport = Object.freeze({
	claimed: 0,
	performed: 0,
	failed: 0,
	claimLost: 0,
});

type ItemOutcome = 'performed' | 'failed' | 'claim-lost';

/**
 * The loop every durable module job runs, and nothing else. It claims bounded
 * work, performs it under a renewed lease at the `concurrency` it was given,
 * isolates each item from the next, backs off when a pass raises and drains
 * every item in flight on stop.
 *
 * It never opens a database handle: the routing read, the claim statement, the
 * renewal statement and the work itself are the module's, handed in as `claim`,
 * `heartbeat` and `perform`.
 */
export function createJobRunner<Claimed>(
	options: JobRunnerOptions<Claimed>,
): JobRunner {
	const name = options.name;
	const now = options.now ?? (() => Date.now());
	const intervalMs = Math.max(1, options.intervalMs);
	const batchLimit = Math.max(1, options.batchLimit ?? DEFAULT_JOB_BATCH_LIMIT);
	const requestedConcurrency = Math.trunc(options.concurrency ?? 1);
	/* Clamped rather than thrown on, and never zero: a pool of no workers would
	   perform nothing while every pass still reported a clean idle. */
	const concurrency = Number.isSafeInteger(requestedConcurrency)
		? Math.min(MAX_JOB_CONCURRENCY, Math.max(1, requestedConcurrency))
		: 1;
	const heartbeat = options.heartbeat;
	const heartbeatEveryMs = Math.max(
		1,
		options.heartbeatEveryMs ??
			Math.max(
				MIN_HEARTBEAT_MS,
				Math.floor(options.staleAfterMs / HEARTBEAT_DIVISOR),
			),
	);
	const backoff = options.backoff;
	const sink = options.onEvent;

	/* A trace sink is the consumer's code. Wrapping it here means a throwing one
	   never reaches the pass, and the optional call below evaluates no event
	   object at all when nobody is listening. */
	const emit = sink
		? (event: JobEvent): void => {
				try {
					sink(event);
				} catch {
					/* An observer that throws is the observer's defect, not the job's. */
				}
			}
		: undefined;

	let disposed = false;
	let started = false;
	let waking = false;
	let failures = 0;
	let inFlight: Promise<JobPassReport> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/* The scheduling chain a stop retires. A pass that outlives its stop must not
	   schedule for a loop that has been started again since. */
	let generation = 0;

	const delay = (): number => {
		if (!backoff || failures === 0) return intervalMs;
		const doublings = Math.min(failures - 1, MAX_BACKOFF_DOUBLINGS);
		return Math.min(
			backoff.maxMs,
			backoff.initialMs * Math.max(1, backoff.multiplier) ** doublings,
		);
	};

	const performItem = async (claimed: Claimed): Promise<ItemOutcome> => {
		const controller = new AbortController();
		let lost = false;
		let beat: ReturnType<typeof setInterval> | undefined;
		if (heartbeat) {
			let beating = false;
			beat = setInterval(() => {
				/* A fence slower than the cadence must not queue behind itself. */
				if (beating) return;
				beating = true;
				void (async () => {
					const at = now();
					try {
						if (await heartbeat(claimed, at)) {
							emit?.({ type: 'heartbeat', name, at });
							return;
						}
					} catch (error) {
						emit?.({ type: 'heartbeat-failed', name, at, error });
						return;
					} finally {
						beating = false;
					}
					lost = true;
					if (beat) clearInterval(beat);
					emit?.({ type: 'claim-lost', name, at });
					controller.abort(new JobClaimLostError(name));
				})();
			}, heartbeatEveryMs);
			beat.unref?.();
		}

		const startedAt = now();
		try {
			await options.perform(claimed, controller.signal);
			/* The stage finished. A fence that answered false while it was settling
			   raced a row that is no longer in flight, and a stage that did observe
			   the abort raises instead of returning, so this is work performed. */
			if (emit) {
				const at = now();
				emit({ type: 'performed', name, at, durationMs: at - startedAt });
			}
			return 'performed';
		} catch (error) {
			/* A stage that stopped on the abort reported the claim, not a failure:
			   the item is somebody else's work now and settles under their pass. */
			if (lost) return 'claim-lost';
			options
				.logger()
				.error(`${name} work failed`, { module: name, err: error });
			emit?.({ type: 'item-failed', name, at: now(), error });
			return 'failed';
		} finally {
			if (beat) clearInterval(beat);
		}
	};

	const pass = async (): Promise<JobPassReport> => {
		/* Read at the head of the pass but published only once the pass has work,
		   so the span a listener opens still covers the claim that found it. */
		const startedAt = emit ? now() : 0;
		let announced = false;
		let attempts = 0;
		let claimed = 0;
		let performed = 0;
		let failed = 0;
		let claimLost = 0;
		let raised = false;
		let drained = false;

		/* One claim attempt, counted against the batch bound whatever it answers.
		   Null ends the pass for every worker: the source is empty or it raised. */
		const take = async (): Promise<Claimed | null> => {
			if (drained || attempts >= batchLimit) return null;
			attempts += 1;
			let item: Claimed | null;
			try {
				item = await options.claim(now());
			} catch (error) {
				/* The source raised, so this pass has nothing further to take. What it
				   already performed keeps its outcomes; the next pass finds the rest. */
				drained = true;
				raised = true;
				options
					.logger()
					.error(`${name} claim failed`, { module: name, err: error });
				emit?.({ type: 'claim-failed', name, at: now(), error });
				return null;
			}
			if (item === null) {
				drained = true;
				return null;
			}
			claimed += 1;
			if (emit) {
				if (!announced) {
					announced = true;
					emit({ type: 'pass-start', name, at: startedAt });
				}
				emit({ type: 'claimed', name, at: now() });
			}
			return item;
		};

		/* A pool of one is the sequential pass itself, with nothing to serialize
		   against; beyond that the workers queue behind one claim at a time. The
		   rejected arm takes the chain back: one link that raised must not leave
		   every other worker waiting on a promise that never settles. */
		let queued: Promise<Claimed | null> = Promise.resolve(null);
		const claimNext =
			concurrency === 1
				? take
				: (): Promise<Claimed | null> => {
						const taken = queued.then(take, take);
						queued = taken;
						return taken;
					};

		const worker = async (): Promise<void> => {
			for (;;) {
				const item = await claimNext();
				if (item === null) return;
				const outcome = await performItem(item);
				if (outcome === 'performed') performed += 1;
				else if (outcome === 'claim-lost') claimLost += 1;
				else {
					failed += 1;
					raised = true;
				}
			}
		};

		const pool: Promise<void>[] = [];
		for (let slot = 0; slot < Math.min(concurrency, batchLimit); slot += 1) {
			pool.push(worker());
		}
		await Promise.all(pool);
		/* A claim another process already held is contention, not a failure, so it
		   never backs the loop off; anything that raised does, until a pass that
		   raises nothing resets it. */
		failures = raised ? Math.min(failures + 1, MAX_BACKOFF_DOUBLINGS + 1) : 0;
		const report: JobPassReport = { claimed, performed, failed, claimLost };
		if (announced) {
			emit?.({
				type: 'pass-end',
				name,
				at: now(),
				report,
				nextDelayMs: delay(),
			});
		}
		return report;
	};

	const tick = (): Promise<JobPassReport> => {
		if (disposed) return Promise.resolve(IDLE);
		if (inFlight) return inFlight;
		const pending = pass().finally(() => {
			if (inFlight === pending) inFlight = undefined;
		});
		inFlight = pending;
		return pending;
	};

	const schedule = (delayMs: number, chain: number): void => {
		timer = setTimeout(() => {
			timer = undefined;
			run(chain);
		}, delayMs);
		/* A poll loop is never the reason a process stays alive. */
		timer.unref?.();
	};

	const run = (chain: number): void => {
		void tick()
			.catch(() => undefined)
			.finally(() => {
				/* A start while a pass is in flight joins that pass, so its chain ends
				   here too. Only the chain a stop has not retired schedules again;
				   without the token both would, and this one timer handle could cancel
				   just one of them. */
				if (disposed || chain !== generation) return;
				schedule(delay(), chain);
			});
	};

	const stop = (): void => {
		started = false;
		waking = false;
		generation += 1;
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const wake = (): void => {
		if (disposed) return;
		if (!inFlight) {
			void tick().catch(() => undefined);
			return;
		}
		/* The pass in flight may already have read past the work this wake is
		   about, so it is followed by one more pass. Every wake arriving while that
		   pass runs coalesces into it. */
		if (waking) return;
		waking = true;
		void inFlight
			.catch(() => undefined)
			.then(() => {
				if (!waking) return;
				waking = false;
				if (disposed) return;
				void tick().catch(() => undefined);
			});
	};

	return {
		name,
		start() {
			if (disposed || started) return;
			started = true;
			run(generation);
		},
		tick,
		wake,
		stop,
		async quiesce() {
			stop();
			await inFlight?.catch(() => undefined);
		},
		async dispose() {
			if (disposed) return;
			stop();
			disposed = true;
			await inFlight?.catch(() => undefined);
		},
	};
}
