import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineListExport,
	encodeCursor,
	type DefinedListExport,
} from '@flowdular/server';
import { ADAPTERS_PERMISSIONS } from '../acl/permissions.ts';
import { ADAPTER_LIMITS, type AdapterRun } from '../domain/types.ts';
import type { AdaptersService } from './adapters-service.ts';

export const ADAPTER_RUNS_LIST_ID = 'adapters.core.runs';

/**
 * The run list as exports.core walks it: the same newest-first keyset the
 * list endpoint answers, under the principal that started the export.
 */
export function adaptersListExports(
	service: () => Promise<AdaptersService>,
): readonly DefinedListExport[] {
	const secret = randomBytes(32);
	return [
		defineListExport<AdapterRun>({
			id: ADAPTER_RUNS_LIST_ID,
			label: 'Data adapter runs',
			permission: ADAPTERS_PERMISSIONS.read,
			columns: [
				{
					key: 'queuedAt',
					header: 'Queued at',
					value: (run) => new Date(run.queuedAt),
				},
				{ key: 'adapterId', header: 'Adapter', value: (run) => run.adapterId },
				{
					key: 'direction',
					header: 'Direction',
					value: (run) => run.direction,
				},
				{ key: 'trigger', header: 'Trigger', value: (run) => run.trigger },
				{ key: 'status', header: 'Status', value: (run) => run.status },
				{ key: 'pages', header: 'Pages', value: (run) => run.pages },
				{ key: 'rowsRead', header: 'Read', value: (run) => run.rowsRead },
				{
					key: 'rowsCreated',
					header: 'Created',
					value: (run) => run.rowsCreated,
				},
				{
					key: 'rowsUpdated',
					header: 'Updated',
					value: (run) => run.rowsUpdated,
				},
				{
					key: 'rowsSkipped',
					header: 'Skipped',
					value: (run) => run.rowsSkipped,
				},
				{ key: 'rowsFailed', header: 'Failed', value: (run) => run.rowsFailed },
				{ key: 'errorCode', header: 'Error', value: (run) => run.errorCode },
				{
					key: 'finishedAt',
					header: 'Finished at',
					value: (run) =>
						run.finishedAt === null ? null : new Date(run.finishedAt),
				},
			],
			page: async (principal, cursor, limit) => {
				let after: { queuedAt: number; id: string } | null = null;
				if (cursor !== null) {
					const value = decodeCursor(cursor, secret);
					if (!Number.isSafeInteger(value.q) || typeof value.i !== 'string') {
						throw new Error('The export cursor is not a run position.');
					}
					after = { queuedAt: value.q as number, id: value.i };
				}
				const page = await (
					await service()
				).runs(principal.tenantId, {
					limit: Math.min(limit, ADAPTER_LIMITS.page),
					after,
				});
				return {
					rows: page.items,
					nextCursor:
						page.next === null
							? null
							: encodeCursor(
									{ q: page.next.queuedAt, i: page.next.id },
									secret,
								),
				};
			},
		}),
	];
}
