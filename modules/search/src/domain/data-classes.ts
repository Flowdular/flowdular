import type {
	DataClassDeclaration,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { SearchRepository } from '../services/repository.ts';

/** Matches the spec entity and the class the spec names, search.core.recent-queries. */
export const SEARCH_RECENT_QUERY_CLASS = 'recent-queries';
export const SEARCH_RECENT_RETENTION_DAYS = 90;

/** Rows read per page while exporting, so a large workspace stays bounded. */
const EXPORT_PAGE = 500;

/** Rows one sweep pass may remove, whatever the registry asks for. */
export const SEARCH_MAX_SWEEP_BATCH = 10_000;

/**
 * The only data search.core holds. Provider records belong to the modules that
 * own them and are declared by those modules, so nothing here reaches another
 * module's table.
 */
export function searchDataClasses(
	repository: () => Promise<SearchRepository>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: SEARCH_RECENT_QUERY_CLASS,
			label: 'Recent searches',
			defaultRetentionDays: SEARCH_RECENT_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).sweepRecent(
					tenantId,
					cutoff.getTime(),
					Math.min(Math.max(Math.trunc(limit), 1), SEARCH_MAX_SWEEP_BATCH),
				),
			}),
			/* Paged by id alone: a row's `ran_at` is rewritten when the member runs
			   the same query again, so a keyset on it would hand the walk the same
			   row twice. The range is tracked instead of read off the order. */
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				const store = await repository();
				let afterId = '';
				let rows = 0;
				let from: number | null = null;
				let to: number | null = null;
				for (;;) {
					const page = await store.exportRecent(tenantId, afterId, EXPORT_PAGE);
					for (const row of page) {
						await sink.write({
							accountId: row.accountId,
							query: row.query,
							ranAt: new Date(row.ranAt).toISOString(),
						});
						if (from === null || row.ranAt < from) from = row.ranAt;
						if (to === null || row.ranAt > to) to = row.ranAt;
						rows += 1;
					}
					const last = page.at(-1);
					if (!last || page.length < EXPORT_PAGE) break;
					afterId = last.id;
				}
				return {
					rows,
					from: from === null ? null : new Date(from),
					to: to === null ? null : new Date(to),
				};
			},
		},
	];
}
