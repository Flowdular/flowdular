import type { DataClassDeclaration } from '@flowdular/kernel';
import type { ImportRepository } from './repository.ts';

/** The class id is `import.core.jobs`. */
export const IMPORT_DATA_CLASS_KEY = 'jobs';

export const IMPORT_RETENTION_DAYS = 180;

/**
 * How long a validated job may wait for its requester. Nothing ever continues
 * it afterwards, so it is cancelled and settles into the same retention as
 * every other job instead of sitting in the list for the whole 180 days.
 */
export const IMPORT_ABANDONED_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Jobs one pass may expire and jobs it may remove. Each removed job carries up
 * to one `maxRows` worth of outcomes, so the bound on jobs is what keeps the
 * row delete bounded as well.
 */
export const IMPORT_SWEEP_JOBS = 500;

/**
 * What this module holds: the jobs, their row outcomes and the saved mappings
 * of one workspace. The CSV itself belongs to documents.core and is swept by
 * that module's own class, never by this one.
 *
 * Only a settled job is swept. A job still parsing or writing is work in
 * flight, and removing it under the poll loop would leave a port mid-import
 * with nothing to record against; a job waiting for a requester who never came
 * back is cancelled first, so it settles rather than waiting out its retention
 * as work in flight.
 */
export function importDataClass(
	repository: () => Promise<ImportRepository>,
	now: () => number = () => Date.now(),
): DataClassDeclaration {
	return {
		key: IMPORT_DATA_CLASS_KEY,
		label: 'Import jobs',
		defaultRetentionDays: IMPORT_RETENTION_DAYS,
		exportable: true,
		sweep: async ({ tenantId, cutoff, limit }) => {
			const at = now();
			return {
				removed: await (
					await repository()
				).sweepJobs(tenantId, {
					settledBefore: cutoff.getTime(),
					abandonedBefore: at - IMPORT_ABANDONED_DAYS * DAY_MS,
					at,
					/* The platform's number is the caller's; this is the module's own
					   bound on one pass. */
					limit: Math.min(Math.max(Math.trunc(limit), 1), IMPORT_SWEEP_JOBS),
				}),
			};
		},
		export: async ({ tenantId, sink }) =>
			(await repository()).exportJobs(tenantId, sink),
	};
}
