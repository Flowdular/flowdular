import type {
	DataClassDeclaration,
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import { AUDIT_REASONS } from '../domain/types.ts';
import type { AuditRepository } from './repository.ts';
import { AuditServiceError } from './service-error.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const OWN_EXPORT_PAGE = 500;

/** The class holding the chain; the two ledgers below age on the same period. */
export const AUDIT_EVENTS_CLASS_ID = 'audit.core.events';

/**
 * How long audit.core keeps its own rows by default, per D-AUDIT-RETENTION-
 * DEFAULTS. It covers the chain and the two ledgers about it: a workspace that
 * never sets a period still stops carrying them for ever.
 */
export const AUDIT_DEFAULT_RETENTION_DAYS = 400;

/**
 * The classes audit.core owns. It declares into its own registry exactly the
 * way every other module does, so the registry has no privileged entry and the
 * ledgers this module keeps are exported like any other data. The repository
 * arrives as a thunk because declaring happens while the platform composes,
 * before anything has opened a database.
 *
 * A link of the chain may be removed only once a segment file holds it, so its
 * sweep is bounded by the newest anchor of the workspace and refuses with
 * SEGMENT_NOT_SEALED rather than passing over an unsealed link in silence. The
 * two ledgers carry no chain and age on the period alone. Keeping the chain is
 * also the documented basis for excluding audit events from erasure on request:
 * the subject-identifying fields of a new event are sealed per subject instead,
 * which is why no class here declares an erase operation.
 *
 * Every tenant table this module owns is declared, so the catalogue a workspace
 * reads is the deployment and not the part of it that happens to be swept. The
 * four below are kept until a person deletes them and carry no sweep: holds and
 * erasure runs are the evidence a lifecycle decision was taken, and the anchors
 * and the subject keys are the integrity material the chain is verified and the
 * sealed events are read through. The two that carry integrity material are not
 * exportable either, and say why: an export of them would hand out the signing
 * evidence and the key material an erasure destroys.
 */
export function auditOwnDataClasses(
	repository: () => Promise<AuditRepository>,
	pageSize = OWN_EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'events',
			label: 'Audit events',
			defaultRetentionDays: AUDIT_DEFAULT_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => {
				const store = await repository();
				const anchor = await store.latestAnchor(tenantId);
				const sealedThrough = anchor?.toSequence ?? 0;
				const removed =
					sealedThrough === 0
						? 0
						: await store.deleteAuditEventsBefore(
								tenantId,
								cutoff.getTime(),
								sealedThrough,
								limit,
							);
				/* Only once a batch found nothing left to remove: a batch that did
				   remove rows must answer with its count, or the pass loses it. */
				if (removed === 0) {
					const [total, sealed] = await Promise.all([
						store.countAuditEventsBefore(tenantId, cutoff.getTime(), null),
						store.countAuditEventsBefore(
							tenantId,
							cutoff.getTime(),
							sealedThrough,
						),
					]);
					if (total - sealed > 0) {
						throw new AuditServiceError(
							AUDIT_REASONS.segmentNotSealed,
							`${total - sealed} audit events of this workspace are older than the period and are in no segment file; run "flowdular audit seal" before retention may remove them.`,
							409,
						);
					}
				}
				return { removed };
			},
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (afterId, limit) =>
						(await repository()).exportAuditEventsPage(
							tenantId,
							afterId,
							limit,
						),
					(event) => ({
						id: event.id,
						at: event.occurredAt,
						row: {
							...event,
							occurredAt: new Date(event.occurredAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'sweep-runs',
			label: 'Retention sweep ledger',
			defaultRetentionDays: AUDIT_DEFAULT_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteSweepRunsBefore(tenantId, cutoff.getTime(), limit),
			}),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (afterId, limit) =>
						(await repository()).exportSweepRunsPage(tenantId, afterId, limit),
					(run) => ({
						id: run.id,
						at: run.occurredAt,
						row: {
							...run,
							cutoff: new Date(run.cutoff).toISOString(),
							occurredAt: new Date(run.occurredAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'export-runs',
			label: 'Export history',
			defaultRetentionDays: AUDIT_DEFAULT_RETENTION_DAYS,
			exportable: true,
			/* A run the platform has not answered is never removed, whatever its
			   age: the command that recorded it is still polling the row. */
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteExportRunsBefore(tenantId, cutoff.getTime(), limit),
			}),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (afterId, limit) =>
						(await repository()).exportExportRunsPage(tenantId, afterId, limit),
					(run) => ({
						id: run.id,
						at: run.startedAt,
						/* The requested directory and the archive path are the
						   deployment's filesystem layout, not the workspace's data,
						   so they stay out of the archive the workspace receives. */
						row: {
							id: run.id,
							tenantId: run.tenantId,
							formatVersion: run.formatVersion,
							status: run.status,
							dryRun: run.dryRun,
							classes: run.classes,
							rows: run.rows,
							archiveDigest: run.archiveDigest,
							requestedBy: run.requestedBy,
							reason: run.reason,
							summary: run.summary,
							startedAt: new Date(run.startedAt).toISOString(),
							completedAt:
								run.completedAt === null
									? null
									: new Date(run.completedAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'legal-holds',
			label: 'Legal holds',
			/* A hold record is the evidence that removal was suspended and why, so
			   it outlives the hold itself and is never aged out. */
			defaultRetentionDays: null,
			exportable: true,
			/* No erase operation: a hold naming a person is the record of a legal
			   instruction about them, which is exactly what an erasure may not
			   remove. The count is what puts it on the certificate, so an operator
			   reads which holds still name the subject instead of being told the
			   subject is gone. */
			count: async ({ tenantId, subject }) =>
				(await repository()).countHoldsForAccount(tenantId, subject.accountId),
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (afterId, limit) =>
						(await repository()).exportLegalHoldsPage(tenantId, afterId, limit),
					(hold) => ({
						id: hold.id,
						at: hold.placedAt,
						row: {
							...hold,
							placedAt: new Date(hold.placedAt).toISOString(),
							liftedAt:
								hold.liftedAt === null
									? null
									: new Date(hold.liftedAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'erasure-runs',
			label: 'Erasure history',
			/* The record that an erasure was performed, kept for as long as the
			   workspace has to be able to prove it happened. The subject was
			   blanked when the run finished, so the row names nobody. */
			defaultRetentionDays: null,
			exportable: true,
			export: ({ tenantId, sink }) =>
				walk(
					sink,
					pageSize,
					async (afterId, limit) =>
						(await repository()).exportErasureRunsPage(
							tenantId,
							afterId,
							limit,
						),
					(run) => ({
						id: run.id,
						at: run.startedAt,
						/* The operator directory and the certificate path are the
						   deployment's filesystem layout, not the workspace's data,
						   so they stay out of the archive the workspace receives. */
						row: {
							id: run.id,
							tenantId: run.tenantId,
							subject: run.subject,
							subjectMarker: run.subjectMarker,
							status: run.status,
							dryRun: run.dryRun,
							destroyKey: run.destroyKey,
							classes: run.classes,
							rows: run.rows,
							outcome: run.outcome,
							requestedBy: run.requestedBy,
							reason: run.reason,
							startedAt: new Date(run.startedAt).toISOString(),
							completedAt:
								run.completedAt === null
									? null
									: new Date(run.completedAt).toISOString(),
						},
					}),
				),
		},
		{
			key: 'anchors',
			label: 'Chain anchors',
			/* An anchor is what a segment file is verified against; removing one
			   would leave evidence nothing can be checked against. */
			defaultRetentionDays: null,
			exportable: false,
			excludedReason:
				'Integrity material: the hashes and the signature every segment file of this workspace is verified against are held by the operator, not handed out in a workspace archive.',
		},
		{
			key: 'subject-keys',
			label: 'Subject data keys',
			/* The row outlives the key: destroying it leaves the tombstone that
			   stops a later event putting the subject back in the clear. */
			defaultRetentionDays: null,
			exportable: false,
			excludedReason:
				'Integrity material: the row holds the key the sealed fields of a subject are read through, so exporting it would hand out exactly what destroying that key takes away.',
		},
	];
}

/**
 * A keyset walk over one ledger. Pages are read by primary key, so the walk
 * terminates on a table that is still being written to and never holds more
 * than one page in memory.
 */
async function walk<T>(
	sink: DataClassExportSink,
	pageSize: number,
	read: (afterId: string, limit: number) => Promise<readonly T[]>,
	present: (record: T) => {
		readonly id: string;
		readonly at: number;
		readonly row: Record<string, unknown>;
	},
): Promise<DataClassExportSummary> {
	let afterId = '';
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const page = await read(afterId, pageSize);
		for (const record of page) {
			const entry = present(record);
			const at = new Date(entry.at);
			if (!from || at < from) from = at;
			if (!to || at > to) to = at;
			afterId = entry.id;
			rows += 1;
			await sink.write(entry.row);
		}
		if (page.length < pageSize) return { rows, from, to };
	}
}
