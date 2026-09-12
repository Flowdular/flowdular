/**
 * The three background loops of audit.core on the platform job runner
 * (`@flowdular/server`). The runner owns the timer and its unref, the guard
 * against overlapping passes, the bound on the work one pass takes, the
 * per-item isolation, the renewal timer with the abort it raises when the fence
 * answers false, and the drain on stop. This module keeps its tables, its
 * routing reads, its claim statements with their stale windows, its renewal
 * statements and every outcome it records.
 *
 * One runner per loop rather than one for audit.core: the intervals, the
 * routing pages and the claims differ, and a retention sweep that ran every
 * five seconds or an export that waited an hour would both be wrong.
 */
import {
	createJobRunner,
	createJobTraceSink,
	serverLogger,
	type JobBackoff,
	type JobEvent,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import type { AuditErasureRun, AuditExportRun } from '../domain/types.ts';
import {
	ERASURE_CLAIM_TIMEOUT_MS,
	ERASURE_POLL_INTERVAL_MS,
	ERASURE_ROUTING_PAGE,
	type AuditErasureService,
} from './erasure-service.ts';
import {
	EXPORT_CLAIM_TIMEOUT_MS,
	EXPORT_POLL_INTERVAL_MS,
	EXPORT_ROUTING_PAGE,
	type AuditExportService,
} from './export-service.ts';
import type { AuditRepository } from './repository.ts';
import {
	SWEEP_ROUTING_PAGE,
	type AuditSweepService,
	type DueDataClass,
} from './sweep-service.ts';

interface RunnerSeams {
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/* One sink per loop: the pass spans it keeps open are that loop's, and the
   three loops here run at cadences of their own. */
function traceSink(options: RunnerSeams): (event: JobEvent) => void {
	return (
		options.onEvent ??
		createJobTraceSink(options.tracer ? { tracer: options.tracer } : {})
	);
}

/**
 * What a loop waits after a pass that raised: its own interval, doubling to ten
 * times that and never past a minute, so a database refusing a claim gets room
 * while a loop slower than a minute keeps its own cadence.
 */
function backoffFrom(intervalMs: number): JobBackoff {
	return {
		initialMs: intervalMs,
		maxMs: Math.max(intervalMs, Math.min(60_000, intervalMs * 10)),
		multiplier: 2,
	};
}

export interface AuditSweepRunnerOptions extends RunnerSeams {
	readonly sweeps: () => Promise<AuditSweepService>;
	/**
	 * Read once, as the cadence was before the runner: the setting's description
	 * says an edited value applies the next time the platform starts. The same
	 * setting is read live per pass for the due cutoff.
	 */
	readonly intervalMs: number;
}

export interface AuditExportRunnerOptions extends RunnerSeams {
	readonly exports: () => Promise<AuditExportService>;
	readonly repository: () => Promise<AuditRepository>;
	readonly pollIntervalMs?: number | undefined;
	readonly claimTimeoutMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
}

export interface AuditErasureRunnerOptions extends RunnerSeams {
	readonly erasures: () => Promise<AuditErasureService>;
	readonly repository: () => Promise<AuditRepository>;
	readonly pollIntervalMs?: number | undefined;
	readonly claimTimeoutMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
}

/** A claimed run and the claim instant every renewal of it is fenced on. */
interface ClaimedRun<Run> {
	readonly run: Run;
	held: number;
}

/** Routing columns are all a cross-workspace read answers. */
interface RunRouting {
	readonly tenantId: string;
	readonly id: string;
}

interface ClaimRunInput extends RunRouting {
	readonly claimedAt: number;
	readonly staleBefore: number;
}

/**
 * The retention sweep. It claims nothing: a class is taken by the compare and
 * swap on the sweep stamp the routing row carried, so there is no lease to hold
 * and none to renew. One pass reads the routing page once and refuses,
 * withholds or sweeps each class of it under the backup evidence that page was
 * read with.
 */
export function createAuditSweepRunner(
	options: AuditSweepRunnerOptions,
): JobRunner {
	/* The page one pass works through. It refills only once drained, and a page
	   shorter than the bound means nothing more was due, so a pass reads the
	   routing table exactly once however many classes it examines. */
	let queue: DueDataClass[] = [];
	let refillable = true;

	return createJobRunner<DueDataClass>({
		name: 'audit.core.sweep',
		intervalMs: options.intervalMs,
		/* No claim and no renewal, so no window: the runner reads the field only
		   to space heartbeats this loop does not have. */
		staleAfterMs: options.intervalMs,
		backoff: backoffFrom(options.intervalMs),
		batchLimit: SWEEP_ROUTING_PAGE,
		logger: serverLogger,
		now: options.now,
		onEvent: traceSink(options),
		claim: async () => {
			if (queue.length === 0 && refillable) {
				const page = await (await options.sweeps()).due(SWEEP_ROUTING_PAGE);
				refillable = page.length === SWEEP_ROUTING_PAGE;
				queue = [...page];
			}
			const next = queue.shift();
			if (!next) {
				refillable = true;
				return null;
			}
			return next;
		},
		perform: async (due) => {
			await (await options.sweeps()).sweep(due);
		},
	});
}

/** Requested exports, claimed under the workspace the routing row named. */
export function createAuditExportRunner(
	options: AuditExportRunnerOptions,
): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? EXPORT_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? EXPORT_POLL_INTERVAL_MS;
	const claim = claimQueue<AuditExportRun>({
		limit: EXPORT_ROUTING_PAGE,
		staleAfterMs,
		page: async (limit) =>
			(await options.repository()).listPendingExportRuns(limit),
		take: async (input) => (await options.repository()).claimExportRun(input),
	});

	return createJobRunner<ClaimedRun<AuditExportRun>>({
		name: 'audit.core.export',
		intervalMs,
		staleAfterMs,
		backoff: backoffFrom(intervalMs),
		batchLimit: EXPORT_ROUTING_PAGE,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent: traceSink(options),
		claim,
		heartbeat: async (item, at) => {
			const renewed = await (
				await options.repository()
			).heartbeatExportRun(item.run.tenantId, item.run.id, at, item.held);
			if (renewed) item.held = at;
			return renewed;
		},
		perform: async (item, signal) => {
			await (await options.exports()).perform(item.run, signal);
			/* The stage records nothing when the claim changed hands and leaves the
			   run as the loop that owns it now will find it. Raising the abort here
			   is how the pass learns the item was contention, not work performed. */
			signal.throwIfAborted();
		},
	});
}

/** Requested erasures, including the expiry of one no platform answered. */
export function createAuditErasureRunner(
	options: AuditErasureRunnerOptions,
): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? ERASURE_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? ERASURE_POLL_INTERVAL_MS;
	const claim = claimQueue<AuditErasureRun>({
		limit: ERASURE_ROUTING_PAGE,
		staleAfterMs,
		page: async (limit) =>
			(await options.repository()).listPendingErasureRuns(limit),
		take: async (input) => (await options.repository()).claimErasureRun(input),
	});

	return createJobRunner<ClaimedRun<AuditErasureRun>>({
		name: 'audit.core.erasure',
		intervalMs,
		staleAfterMs,
		backoff: backoffFrom(intervalMs),
		batchLimit: ERASURE_ROUTING_PAGE,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent: traceSink(options),
		claim,
		heartbeat: async (item, at) => {
			const renewed = await (
				await options.repository()
			).heartbeatErasureRun(item.run.tenantId, item.run.id, at, item.held);
			if (renewed) item.held = at;
			return renewed;
		},
		perform: async (item, signal) => {
			await (await options.erasures()).perform(item.run, signal);
			signal.throwIfAborted();
		},
	});
}

/**
 * One claim attempt over a routing page held between calls. Both request loops
 * read routing columns across workspaces on the background lease and claim
 * under the workspace the routing row named, so they share the walk and keep
 * their own statements.
 */
function claimQueue<Run>(options: {
	readonly limit: number;
	readonly staleAfterMs: number;
	readonly page: (limit: number) => Promise<readonly RunRouting[]>;
	readonly take: (input: ClaimRunInput) => Promise<Run | null>;
}): (at: number) => Promise<ClaimedRun<Run> | null> {
	let queue: RunRouting[] = [];
	let refillable = true;
	/* Rows this pass walked past without taking them. The runner bounds the
	   claims it is handed; this bounds the rows read to find them, so a page of
	   runs other processes hold cannot cost one routing read per row. */
	let skipped = 0;

	return async (at) => {
		while (skipped < options.limit) {
			if (queue.length === 0) {
				if (!refillable) break;
				const page = await options.page(options.limit);
				refillable = page.length === options.limit;
				queue = [...page];
				if (queue.length === 0) break;
			}
			const routing = queue.shift()!;
			const run = await options.take({
				tenantId: routing.tenantId,
				id: routing.id,
				claimedAt: at,
				staleBefore: at - options.staleAfterMs,
			});
			/* The claim statement wrote `at`, so that is the instant every renewal
			   fences on. */
			if (run) return { run, held: at };
			/* Another process holds it, or it was answered between the routing read
			   and the claim. Either way it is not this pass's work. */
			skipped += 1;
		}
		/* Null ends the pass, so the next one walks a budget of its own and asks
		   the queue again for whatever is left here. */
		skipped = 0;
		refillable = true;
		return null;
	};
}
