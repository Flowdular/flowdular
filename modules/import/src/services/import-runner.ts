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
	IMPORT_LIMITS,
	type ClaimedImportJob,
	type ImportJobRouting,
} from '../domain/types.ts';
import type { ImportService } from './import-service.ts';
import type { ImportRepository } from './repository.ts';

export interface ImportRunnerOptions {
	readonly repository: () => Promise<ImportRepository>;
	readonly service: () => Promise<ImportService>;
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
 * declares `maxRows` and `batchSize` and no cadence, and an operator who needs
 * a different one is asking for a spec change, not a knob.
 */
export const IMPORT_POLL_INTERVAL_MS = 2_000;

/** Ten minutes: longer than the largest job, shorter than an operator's patience. */
export const IMPORT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The import job as the platform runner sees it: a claim, a renewal and one
 * stage of work. The loop, its bound, its backoff, its renewal timer and its
 * drain are the runner's (`@flowdular/server`); the routing read, the claim
 * statement, the stale window and every outcome recorded stay here.
 */
export function createImportJobRunner(options: ImportRunnerOptions): JobRunner {
	const staleAfterMs = options.claimTimeoutMs ?? IMPORT_CLAIM_TIMEOUT_MS;
	const intervalMs = options.pollIntervalMs ?? IMPORT_POLL_INTERVAL_MS;
	/* The routing read crosses workspaces on the background role and answers
	   routing columns alone. It refills only once the page it filled is drained,
	   and a page shorter than the bound means the queue held nothing more, so a
	   pass reads it at most twice however many jobs it claims. */
	let queue: ImportJobRouting[] = [];
	let refillable = true;
	/* Rows this pass walked past without taking them. The runner bounds the
	   claims it is handed; this bounds the rows read to find them, so a queue of
	   jobs other processes hold cannot cost one routing read per row. */
	let skipped = 0;
	/* The claim each renewal is fenced on. Weak so a job the runner has finished
	   with is reclaimed with it, without a sweep of its own. */
	const held = new WeakMap<ClaimedImportJob, number>();

	return createJobRunner<ClaimedImportJob>({
		name: 'import.core',
		intervalMs,
		staleAfterMs,
		backoff: jobBackoff(intervalMs),
		batchLimit: IMPORT_LIMITS.routingPage,
		heartbeatEveryMs: options.heartbeatEveryMs,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => {
			const repository = await options.repository();
			while (skipped < IMPORT_LIMITS.routingPage) {
				if (queue.length === 0) {
					if (!refillable) break;
					const page = await repository.listPendingJobs(
						IMPORT_LIMITS.routingPage,
					);
					refillable = page.length === IMPORT_LIMITS.routingPage;
					queue = [...page];
					if (queue.length === 0) break;
				}
				const routing = queue.shift()!;
				const claimed = await repository.claimJob({
					tenantId: routing.tenantId,
					id: routing.id,
					claimedAt: at,
					staleBefore: at - staleAfterMs,
				});
				if (claimed) return claimed;
				/* Another process holds it, or it left the queue between the routing
				   read and the claim. Either way it is not this pass's work. */
				skipped += 1;
			}
			/* Null ends the pass, so the next one walks a budget of its own and asks
			   the queue again for whatever is left here. */
			skipped = 0;
			refillable = true;
			return null;
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
