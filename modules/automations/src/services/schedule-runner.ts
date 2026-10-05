import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
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
import type { TimeZoneFollower, TimeZoneHold } from './time-zone-follower.ts';

/** Schedules one pass fires, and the page the cross-tenant poll answers. */
export const SCHEDULE_POLL_PAGE = 20;

/**
 * Held cron slots one pass steps over without spending a claim, each read
 * under its own tenant. Past it a held slot takes a claim like any other, so
 * the walk still moves on.
 */
export const SCHEDULE_HELD_SKIPS = 10 * SCHEDULE_POLL_PAGE;

export interface AutomationScheduleRunnerOptions {
	readonly repository: () => Promise<AutomationsRepository>;
	readonly service: () => Promise<AutomationScheduleService>;
	/** Applies workspace zone changes at the head of every pass. */
	readonly timeZones?: TimeZoneFollower | undefined;
	/** The platform setting, read once when the loop starts. */
	readonly intervalMs: number;
	readonly now?: (() => number) | undefined;
	/** Absent turns every pass into spans; a sink of its own replaces that. */
	readonly onEvent?: ((event: JobEvent) => void) | undefined;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

interface ClaimedSchedule {
	readonly routing: AutomationScheduleRouting;
	readonly holdCron: boolean;
}

interface SchedulePass {
	readonly hold: TimeZoneHold;
	queue: AutomationScheduleRouting[];
	/** The poll answered a short page, so nothing due lies past the queue. */
	last: boolean;
	claimed: number;
	skipped: number;
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
	   columns alone, in pages walked by keyset. A pass resumes the walk after
	   the last row the one before it examined, and the walk starts over once it
	   reached the end, so a slot that stays due, held or failing, delays the
	   slots behind it by one walk at most instead of taking every pass. */
	let after: AutomationScheduleRouting | null = null;
	/* Open from the first claim of a pass to the null or the error that ends
	   it. The claim answers that null itself, so no page read before a pass's
	   zone changes were applied is served in it. */
	let pass: SchedulePass | null = null;

	const open = async (): Promise<SchedulePass> => ({
		/* Zone changes committed before the pass began move their workspaces'
		   cron slots before the poll can find one due in an older zone. */
		hold: (await options.timeZones?.pass()) ?? (() => false),
		queue: [],
		last: false,
		claimed: 0,
		skipped: 0,
	});

	/* A slot that cannot be read here is claimed instead, so the runner
	   isolates and reports its failure like any other schedule's. */
	const isCronSlot = async (
		routing: AutomationScheduleRouting,
	): Promise<boolean> => {
		try {
			return await (await options.service()).isCronSlot(routing);
		} catch {
			return false;
		}
	};

	const next = async (
		current: SchedulePass,
		at: number,
	): Promise<ClaimedSchedule | null> => {
		while (current.claimed < SCHEDULE_POLL_PAGE) {
			const routing = current.queue.shift();
			if (!routing) {
				if (current.last) {
					after = null;
					return null;
				}
				const repository = await options.repository();
				current.queue = [
					...(await repository.listDueSchedules(at, SCHEDULE_POLL_PAGE, after)),
				];
				current.last = current.queue.length < SCHEDULE_POLL_PAGE;
				continue;
			}
			after = routing;
			const holdCron = current.hold(routing.tenantId);
			if (
				holdCron &&
				current.skipped < SCHEDULE_HELD_SKIPS &&
				(await isCronSlot(routing))
			) {
				current.skipped += 1;
				continue;
			}
			current.claimed += 1;
			return { routing, holdCron };
		}
		return null;
	};

	return createJobRunner<ClaimedSchedule>({
		name: 'automations.core',
		intervalMs: options.intervalMs,
		/* A schedule claims nothing: the next run time the advance compares and
		   swaps, and the slot key the run carries, are its fence, so no lease is
		   held and no renewal runs. */
		staleAfterMs: options.intervalMs,
		backoff: jobBackoff(options.intervalMs),
		/* One above the page, so the null that ends every pass is the claim's. */
		batchLimit: SCHEDULE_POLL_PAGE + 1,
		logger: serverLogger,
		now: options.now,
		onEvent:
			options.onEvent ??
			createJobTraceSink(options.tracer ? { tracer: options.tracer } : {}),
		claim: async (at) => {
			try {
				pass ??= await open();
				const claimed = await next(pass, at);
				if (!claimed) pass = null;
				return claimed;
			} catch (error) {
				pass = null;
				throw error;
			}
		},
		perform: async ({ routing, holdCron }) => {
			await (await options.service()).fireDue(routing, { holdCron });
		},
	});
}
