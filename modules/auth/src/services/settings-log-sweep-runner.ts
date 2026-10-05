import {
	createJobRunner,
	createJobTraceSink,
	jobBackoff,
	type JobRunner,
	type Tracer,
} from '@flowdular/server';
import type { AuthRepository } from './repository.ts';
import { sweepLogger } from './session-sweep-runner.ts';
import { sweepSettingsLog } from './settings-store.ts';

/** Stable id of the loop: the `module` field of every line it logs. */
export const SETTINGS_LOG_SWEEP_JOB = 'auth.core.settings-log';

export interface SettingsLogSweepRunnerOptions {
	readonly repository: () => Promise<AuthRepository>;
	/** The longest a platform change waits for its owed workspace event after a crash. */
	readonly intervalMs: number;
	readonly tracer?: Tracer | undefined;
}

/**
 * The settings log upkeep as the platform runner sees it, on the same terms as
 * the expired session sweep: the runner owns the loop, the overlap guard, the
 * backoff and the drain on dispose, and every statement and row bound stays
 * in the repository.
 */
export function createSettingsLogSweepRunner(
	options: SettingsLogSweepRunnerOptions,
): JobRunner {
	return createJobRunner<number>({
		name: SETTINGS_LOG_SWEEP_JOB,
		intervalMs: options.intervalMs,
		staleAfterMs: options.intervalMs,
		backoff: jobBackoff(options.intervalMs),
		batchLimit: 1,
		logger: () => sweepLogger(SETTINGS_LOG_SWEEP_JOB),
		onEvent: createJobTraceSink(
			options.tracer ? { tracer: options.tracer } : {},
		),
		claim: (at) => Promise.resolve(at),
		perform: async () => {
			await sweepSettingsLog(await options.repository());
		},
	});
}
