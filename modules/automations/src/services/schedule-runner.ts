import {
	createJobRunner,
	createJobTraceSink,
	serverLogger,
	type JobEvent,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import type { AutomationScheduleService } from './schedule-service.ts';
import type {
	AutomationScheduleRouting,
	AutomationsRepository,
} from './repository.ts';

/** Schedules one pass fires, and the page the cross-tenant poll answers. */
export const SCHEDULE_POLL_PAGE = 20;

export interface AutomationScheduleRunnerOptions {
	readonly repository: () => Promise<AutomationsRepository>;
	readonly service: () => Promise<AutomationScheduleService>;
	/** The platform setting, read once when the loop starts. */
	readonly intervalMs: number;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/**
 * The scheduler pass as the platform runner sees it: a claim over routing
 * columns and one due schedule fired per claim. The loop, its bound, the guard
 * against overlapping passes, the isolation of one schedule from the next and
 * the drain are the runner's (`@flowdular/server`); the cross-tenant poll, the
 * re-read under the workspace it named and the slot advance stay here.
 */
export function createAutomationScheduleRunner(
	options: AutomationScheduleRunnerOptions,
): JobRunner {
	/* The poll crosses workspaces on the background role and answers routing
	   columns alone. It refills only once the page it filled is drained, and a
	   page shorter than the bound means nothing further was due, so a pass reads
	   it at most twice however many schedules it fires. */
	let queue: AutomationScheduleRouting[] = [];
	let refillable = true;

	return createJobRunner<AutomationScheduleRouting>({
		name: 'automations.core',
		intervalMs: options.intervalMs,
		/* A schedule claims nothing: the next run time the advance compares and
		   swaps, and the slot key the run carries, are its fence, so no lease is
		   held and no renewal runs. */
		staleAfterMs: options.intervalMs,
		/* A pass that raised waits its own interval, doubling to ten times that
		   and never past a minute, so a database refusing the poll gets room. */
		backoff: {
			initialMs: options.intervalMs,
			maxMs: Math.max(
				options.intervalMs,
				Math.min(60_000, options.intervalMs * 10),
			),
			multiplier: 2,
		},
		batchLimit: SCHEDULE_POLL_PAGE,
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
				const page = await repository.listDueSchedules(at, SCHEDULE_POLL_PAGE);
				refillable = page.length === SCHEDULE_POLL_PAGE;
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
			await (await options.service()).fireDue(routing);
		},
	});
}
