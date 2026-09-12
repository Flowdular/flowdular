import type {
	DataClassDeclaration,
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type {
	ConnectorExportCursor,
	ConnectorsRepository,
} from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/**
 * Days a call log row is kept. A connector call is the evidence a workspace
 * needs when an external system disputes what it was asked to do, and that
 * question is asked across a financial year and its audit, so the default is a
 * year plus the weeks a close runs into.
 */
export const CALL_RETENTION_DAYS = 400;

/**
 * The classes connectors.core owns.
 *
 * Instances and the audit trail carry no sweep. Both are configuration and its
 * history rather than volume that ages: sweeping an instance would delete a
 * live connection, and sweeping the trail would remove the record of who
 * granted a consent while that consent still stands. They are kept until a
 * person deletes them.
 *
 * The call log is the one class that grows with use, so it is the one with a
 * retention period. Its sweep also removes the idempotency keys claimed before
 * the cutoff, which is what keeps a surviving key from pointing at a call that
 * is gone: a key is always claimed no later than the call it names.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function connectorsDataClasses(
	repository: () => Promise<ConnectorsRepository>,
	pageSize = EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'calls',
			label: 'Connector call log',
			defaultRetentionDays: CALL_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteCallsBefore(tenantId, cutoff.getTime(), limit),
			}),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (after, limit) =>
						(await repository()).exportCallsPage(tenantId, after, limit),
					(call) => ({
						cursor: { occurredAt: call.occurredAt, id: call.id },
						at: call.occurredAt,
						row: {
							...call,
							occurredAt: new Date(call.occurredAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'audit',
			label: 'Connector audit trail',
			defaultRetentionDays: null,
			exportable: true,
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (after, limit) =>
						(await repository()).exportAuditPage(tenantId, after, limit),
					(event) => ({
						cursor: { occurredAt: event.occurredAt, id: event.id },
						at: event.occurredAt,
						row: {
							...event,
							occurredAt: new Date(event.occurredAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'instances',
			label: 'Connector instances',
			defaultRetentionDays: null,
			exportable: true,
			/* The repository hands instances over without their envelope, so the
			   export carries the fingerprint and never the credential. */
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (after, limit) =>
						(await repository()).exportInstancesPage(tenantId, after, limit),
					(instance) => ({
						cursor: { occurredAt: instance.createdAt, id: instance.id },
						at: instance.createdAt,
						row: {
							...instance,
							createdAt: new Date(instance.createdAt).toISOString(),
							updatedAt: new Date(instance.updatedAt).toISOString(),
							lastCallAt:
								instance.lastCallAt === null
									? null
									: new Date(instance.lastCallAt).toISOString(),
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
	read: (
		after: ConnectorExportCursor | null,
		limit: number,
	) => Promise<readonly T[]>,
	present: (record: T) => {
		readonly cursor: ConnectorExportCursor;
		readonly at: number;
		readonly row: Record<string, unknown>;
	},
): Promise<DataClassExportSummary> {
	let after: ConnectorExportCursor | null = null;
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
