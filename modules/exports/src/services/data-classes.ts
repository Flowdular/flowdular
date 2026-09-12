import type { DataClassDeclaration } from '@flowdular/kernel';
import type { ExportService } from './export-service.ts';
import type { ExportRepository } from './repository.ts';

/** The class id is `exports.core.jobs`. */
export const EXPORT_DATA_CLASS_KEY = 'jobs';

export const EXPORT_RETENTION_DAYS = 30;

/**
 * Jobs one pass may remove. Each carries one stored file, so the bound on jobs
 * is what keeps the storage work of a pass bounded as well.
 */
export const EXPORT_SWEEP_JOBS = 200;

/**
 * What this module holds: the export jobs of one workspace and the files they
 * name. The rows of the exported lists belong to the modules that own them and
 * are swept by their own classes, never by this one.
 *
 * Only a settled job is swept. A job still running is work in flight, and
 * removing it under the poll loop would leave a stage writing a file against a
 * row that is gone.
 */
export function exportsDataClass(
	repository: () => Promise<ExportRepository>,
	service: () => Promise<ExportService>,
): DataClassDeclaration {
	return {
		key: EXPORT_DATA_CLASS_KEY,
		label: 'Export jobs',
		defaultRetentionDays: EXPORT_RETENTION_DAYS,
		exportable: true,
		sweep: async ({ tenantId, cutoff, limit }) => {
			const open = await repository();
			const batch = await open.claimSweepBatch(tenantId, {
				settledBefore: cutoff.getTime(),
				/* The platform's number is the caller's; this is the module's own
				   bound on one pass. */
				limit: Math.min(Math.max(Math.trunc(limit), 1), EXPORT_SWEEP_JOBS),
			});
			if (batch.ids.length === 0) return { removed: 0 };
			/* The file goes before the row it belongs to. An interrupted pass then
			   leaves a row naming a file that is gone, which the next pass removes
			   and a read answers as gone; the other order would leave a file
			   nothing references and no pass could ever find. */
			await (await service()).discardObjects(tenantId, batch.objectIds);
			return { removed: await open.deleteJobs(tenantId, batch.ids) };
		},
		/* Metadata only. The requester snapshot is bookkeeping for a background
		   stage, and the exported files are the lists' own data, already covered
		   by the classes of the modules that own them. */
		export: async ({ tenantId, sink }) =>
			(await repository()).exportJobs(tenantId, sink),
	};
}
