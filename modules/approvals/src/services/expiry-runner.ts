import {
	createJobRunner,
	createJobTraceSink,
	serverLogger,
	type JobEvent,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import type { ApprovalRouting } from '../domain/types.ts';
import type { ApprovalsService } from './approvals-service.ts';
import type { ApprovalsRepository } from './repository.ts';

/** Requests one expiry pass claims, and the page its routing read answers. */
export const EXPIRY_BATCH = 100;

export interface ApprovalsExpiryRunnerOptions {
	readonly repository: () => Promise<ApprovalsRepository>;
	readonly service: () => Promise<ApprovalsService>;
	/** The platform setting, read once when the loop starts. */
	readonly intervalMs: number;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/**
 * The expiry pass as the platform runner sees it: a claim over routing columns
 * and one request expired per claim. The loop, its bound, the guard against
 * overlapping passes, the isolation of one request from the next and the drain
 * are the runner's (`@flowdular/server`); the routing read and the transition
 * under the workspace stay here.
 */
export function createApprovalsExpiryRunner(
	options: ApprovalsExpiryRunnerOptions,
): JobRunner {
	/* The routing read crosses workspaces on the background role and answers
	   routing columns alone. It refills only once the page it filled is drained,
	   and a page shorter than the bound means nothing further was due, so a pass
	   reads it at most twice however many requests it expires. */
	let queue: ApprovalRouting[] = [];
	let refillable = true;

	return createJobRunner<ApprovalRouting>({
		name: 'approvals.core',
		intervalMs: options.intervalMs,
		/* Expiry claims nothing: the pending status the transition compares and
		   swaps is its own fence, so no lease is held and no renewal runs. */
		staleAfterMs: options.intervalMs,
		/* A pass that raised waits its own interval, doubling to ten times that
		   and never past a minute, so a database refusing the read gets room. */
		backoff: {
			initialMs: options.intervalMs,
			maxMs: Math.max(
				options.intervalMs,
				Math.min(60_000, options.intervalMs * 10),
			),
			multiplier: 2,
		},
		batchLimit: EXPIRY_BATCH,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => {
			if (queue.length === 0) {
				if (!refillable) {
					refillable = true;
					return null;
				}
				const repository = await options.repository();
				const page = await repository.listDueExpiries(at, EXPIRY_BATCH);
				refillable = page.length === EXPIRY_BATCH;
				queue = [...page];
			}
			const routing = queue.shift();
			if (!routing) {
				refillable = true;
				return null;
			}
			return routing;
		},
		perform: async (routing) => {
			await (await options.service()).expireRequest(routing);
		},
	});
}
