import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	serverLogger,
	type JobEvent,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import {
	EXPORT_LIMITS,
	type ClaimedExportJob,
	type ExportJobRouting,
} from '../domain/types.ts';
import type { ExportService } from './export-service.ts';
import type { ExportRepository } from './repository.ts';

export interface ExportRunnerOptions {
	readonly repository: () => Promise<ExportRepository>;
	readonly service: () => Promise<ExportService>;
	/** A claim older than this belonged to a process that is gone. */
	readonly claimTimeoutMs?: number | undefined;
	readonly pollIntervalMs?: number | undefined;
	readonly heartbeatEveryMs?: number | undefined;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/**
 * How often the job poll runs. A constant rather than a setting: the spec
 * declares `maxRows` and `maxBytes` and no cadence, and an operator who needs a
 * different one is asking for a spec change, not a knob.
 */
export const EXPORT_POLL_INTERVAL_MS = 2_000;

/** Ten minutes: longer than the largest export, shorter than an operator's patience. */
export const EXPORT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The export job as the platform runner sees it: a claim, a renewal and one
 * stage of work. The loop, its bound, its backoff, its renewal timer and its
 * drain are the runner's (`@flowdular/server`); the routing read, the claim
 * statement, the stale window and every outcome recorded stay here.
 */
export function createExportJobRunner(options: ExportRunnerOptions): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? EXPORT_CLAIM_TIMEOUT_MS;
	/* The routing read crosses workspaces on the background role and answers
	   routing columns alone. It refills only once the page it filled is drained,
	   and a page shorter than the bound means the queue held nothing more, so a
	   pass reads it at most twice however many jobs it claims. */
	let queue: ExportJobRouting[] = [];
	let refillable = true;
	/* The claim each renewal is fenced on. Weak so a job the runner has finished
	   with is reclaimed with it, without a sweep of its own. */
	const held = new WeakMap<ClaimedExportJob, number>();

	const intervalMs = options.pollIntervalMs ?? EXPORT_POLL_INTERVAL_MS;
	return createJobRunner<ClaimedExportJob>({
		name: 'exports.core',
		intervalMs,
		backoff: jobBackoff(intervalMs),
		staleAfterMs,
		batchLimit: EXPORT_LIMITS.routingPage,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => {
			const repository = await options.repository();
			if (queue.length === 0) {
				if (!refillable) {
					refillable = true;
					return null;
				}
				const page = await repository.listPendingJobs(
					EXPORT_LIMITS.routingPage,
				);
				refillable = page.length === EXPORT_LIMITS.routingPage;
				queue = [...page];
			}
			for (;;) {
				const routing = queue.shift();
				if (!routing) {
					refillable = true;
					return null;
				}
				const claimed = await repository.claimJob({
					tenantId: routing.tenantId,
					id: routing.id,
					claimedAt: at,
					staleBefore: at - staleAfterMs,
				});
				/* Another process holds it, or it left the queue between the routing
				   read and the claim. Either way it is not this pass's work. */
				if (claimed) return claimed;
			}
		},
		heartbeat: async (job, at) => {
			const repository = await options.repository();
			const renewed = await repository.heartbeatJob(
				job.tenantId,
				job.id,
				at,
				held.get(job) ?? job.claimedAt,
			);
			if (renewed) held.set(job, at);
			return renewed;
		},
		perform: async (job, signal) => {
			await (await options.service()).perform(job, signal);
			/* The stage never throws: a lost claim is recorded by recording nothing
			   and answering the job as the loop that now owns it left it. Raising
			   the abort here is how the pass learns the item was contention rather
			   than work it performed. */
			signal.throwIfAborted();
		},
	});
}
