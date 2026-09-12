import type {
	DataClassDeclaration,
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { ExportCursor, NotificationsRepository } from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/**
 * Days an inbox item is kept. An item is a member's record that something
 * already happened, so it outlives the delivery attempt that announced it: a
 * year answers the questions a workspace asks about a notification without
 * keeping a personal record forever.
 */
export const INBOX_RETENTION_DAYS = 365;

/**
 * The declared default of the notifications.core `retentionDays` setting, which
 * the delivery loop already enforces on every tick. The catalogue has to state
 * the period the module actually runs, so this moves with that setting.
 */
export const DELIVERY_RETENTION_DAYS = 30;

/**
 * The classes notifications.core owns. Preferences and webhook subscriptions
 * are not here: they are the workspace's configuration, kept until a person
 * changes them, not history that ages out, and a sweep of either would silently
 * re-enable a kind a member switched off or stop a live subscription.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function notificationsDataClasses(
	repository: () => Promise<NotificationsRepository>,
	pageSize = EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'inbox',
			label: 'Inbox notifications',
			defaultRetentionDays: INBOX_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteInboxItemsBefore(tenantId, cutoff.getTime(), limit),
			}),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (after, limit) =>
						(await repository()).exportInboxPage(tenantId, after, limit),
					(item) => ({
						cursor: { createdAt: item.createdAt, id: item.id },
						at: item.createdAt,
						row: {
							...item,
							createdAt: new Date(item.createdAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'deliveries',
			label: 'Webhook delivery attempts',
			defaultRetentionDays: DELIVERY_RETENTION_DAYS,
			exportable: true,
			/* The same statement the delivery loop's own retention pass runs, so
			   there is one deletion path with two drivers rather than a second one
			   that could disagree with it. It removes completed attempts only: an
			   attempt still queued or in flight is never swept out from under the
			   loop, however old the event behind it is. */
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteCompletedDeliveriesBefore(tenantId, cutoff.getTime(), limit),
			}),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (after, limit) =>
						(await repository()).exportDeliveriesPage(tenantId, after, limit),
					(attempt) => ({
						cursor: { createdAt: attempt.createdAt, id: attempt.id },
						at: attempt.occurredAt,
						row: {
							...attempt,
							scheduledFor: new Date(attempt.scheduledFor).toISOString(),
							completedAt:
								attempt.completedAt === null
									? null
									: new Date(attempt.completedAt).toISOString(),
							occurredAt: new Date(attempt.occurredAt).toISOString(),
							createdAt: new Date(attempt.createdAt).toISOString(),
						},
					}),
				),
		},
	];
}

/**
 * A keyset walk over one table. Pages are read by an immutable key, so the walk
 * terminates on a table that is still being written to and never holds more
 * than one page in memory. The reported range is the oldest and newest record
 * time, which need not be the order the walk visits rows in.
 */
async function walk<T>(
	sink: DataClassExportSink,
	pageSize: number,
	read: (after: ExportCursor | null, limit: number) => Promise<readonly T[]>,
	present: (record: T) => {
		readonly cursor: ExportCursor;
		readonly at: number;
		readonly row: Record<string, unknown>;
	},
): Promise<DataClassExportSummary> {
	let after: ExportCursor | null = null;
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const page = await read(after, pageSize);
		for (const record of page) {
			const entry = present(record);
			const at = new Date(entry.at);
			if (!from || at < from) from = at;
			if (!to || at > to) to = at;
			after = entry.cursor;
			rows += 1;
			await sink.write(entry.row);
		}
		if (page.length < pageSize) return { rows, from, to };
	}
}
