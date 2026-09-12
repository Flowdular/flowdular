import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	serverLogger,
	type JobRunner,
	type Logger,
	type Tracer,
} from '@flowdular/server';

/** Stable id of the loop: the `module` field of every line it logs. */
export const SESSION_SWEEP_JOB = 'auth.core.sessions';

/** What the sweep needs of the service: the bounded delete and nothing else. */
export interface ExpiredSessionSweep {
	deleteExpiredSessions(): Promise<number>;
}

export interface SessionSweepRunnerOptions {
	readonly sweep: () => Promise<ExpiredSessionSweep>;
	readonly intervalMs: number;
	/** Defaults to the process tracer, which is the one `context.tracer` carries. */
	readonly tracer?: Tracer | undefined;
}

/* A repository error can carry the SQL parameters of the statement that raised,
   and a session token hash is one of them. The sweep publishes what kind of
   value was thrown and never the value itself, so the runner's own error line
   is written through this logger rather than the process one. */
function sweepLogger(): Logger {
	const logger = serverLogger();
	return {
		...logger,
		error: (message, event) =>
			logger.error(message, {
				module: event?.module ?? SESSION_SWEEP_JOB,
				fields: { error: event?.err instanceof Error ? 'Error' : 'non-error' },
			}),
	};
}

/**
 * The expired session sweep as the platform runner sees it. The loop, its
 * interval and unref, the guard against overlapping passes, the backoff and the
 * drain on dispose are the runner's (`@flowdular/server`); the row bound on the
 * delete and every statement it issues stay in the repository behind the
 * service.
 */
export function createSessionSweepRunner(
	options: SessionSweepRunnerOptions,
): JobRunner {
	return createJobRunner<number>({
		name: SESSION_SWEEP_JOB,
		intervalMs: options.intervalMs,
		/* The sweep claims nothing: no row is leased, so no renewal can lapse and
		   nothing can take the work over while a pass runs. */
		staleAfterMs: options.intervalMs,
		backoff: jobBackoff(options.intervalMs),
		/* One claim per pass, and the claim is the pass itself: the delete it
		   performs carries its own row bound and leaves the rest to the next. */
		batchLimit: 1,
		logger: sweepLogger,
		/* Spans carry the loop name, the counts and a reason code, never the value
		   a statement threw, so the sweep's own refusal to serialize it holds. */
		onEvent: createJobTraceSink(
			options.tracer ? { tracer: options.tracer } : {},
		),
		claim: (at) => Promise.resolve(at),
		perform: async () => {
			await (await options.sweep()).deleteExpiredSessions();
		},
	});
}
