import { createHash, randomUUID } from 'node:crypto';
import type {
	DatabaseHandle,
	DatabaseParameter,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import {
	AUDIT_SEALED_MARKER,
	type AuditChainAnchor,
	type AuditDataClass,
	type AuditErasureRun,
	type AuditEvent,
	type AuditExportRun,
	type AuditLegalHold,
	type AuditSubjectKey,
	type AuditSubjectType,
	type AuditSweepRun,
	type ErasureClassOutcome,
	type ErasureRunStatus,
	type ExportRunSummary,
	type ExportStatus,
	type HoldScopeKind,
	type HoldStatus,
	type RetentionMode,
	type SweepStatus,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import { AuditServiceError } from './service-error.ts';
import type {
	AnchorKeyCount,
	AnchorRouting,
	AppendAuditEventInput,
	ClaimErasureRunInput,
	ErasureRunRouting,
	FinishErasureRunInput,
	StartErasureRunInput,
	AppendSweepRunInput,
	AuditRepository,
	ClaimExportRunInput,
	DataClassFacts,
	DataClassRouting,
	ExportRunRouting,
	FinishExportRunInput,
	InsertAnchorInput,
	InsertHoldInput,
	LiftHoldRecordInput,
	StartExportRunInput,
	StoredAuditEvent,
	SubjectKeyMaterial,
} from './repository.ts';
import {
	decodeSubjectKey,
	encodeSubjectKey,
	erasureSubjectMarker,
	generateSubjectKey,
	openSubjectPayload,
	sealSubjectPayload,
	subjectSealContext,
} from './subject-keys.ts';

export interface AuditDatabaseHandles {
	/** Tenant-scoped runtime lease; every statement carries a tenant id. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read-only lease, routing columns only. */
	readonly background: DatabaseHandle;
}

interface DataClassRow {
	id: string;
	tenant_id: string;
	class_id: string;
	module_id: string;
	label: string;
	exportable: number | bigint | string;
	sweepable: number | bigint | string;
	default_retention_days: number | bigint | string | null;
	retention_mode: RetentionMode;
	retention_days: number | bigint | string | null;
	last_swept_at: number | bigint | string | null;
	created_at: number | bigint | string;
	updated_at: number | bigint | string;
}

interface SweepRunRow {
	id: string;
	tenant_id: string;
	class_id: string;
	cutoff: number | bigint | string;
	removed: number | bigint | string;
	status: SweepStatus;
	reason: string | null;
	held_back: number | bigint | string | null;
	occurred_at: number | bigint | string;
}

interface AnchorRow {
	id: string;
	tenant_id: string;
	anchor_sequence: number | bigint | string;
	from_sequence: number | bigint | string;
	to_sequence: number | bigint | string;
	row_count: number | bigint | string;
	first_occurred_at: number | bigint | string;
	last_occurred_at: number | bigint | string;
	segment_hash: string;
	previous_anchor_hash: string | null;
	anchor_hash: string;
	signature: string;
	key_id: string;
	segment_file: string;
	sealed_by: string;
	sealed_at: number | bigint | string;
}

interface LegalHoldRow {
	id: string;
	tenant_id: string;
	scope_kind: HoldScopeKind;
	account_id: string | null;
	class_id: string | null;
	from_at: number | bigint | string | null;
	to_at: number | bigint | string | null;
	reason: string;
	status: HoldStatus;
	placed_by: string;
	placed_at: number | bigint | string;
	lifted_by: string | null;
	lift_reason: string | null;
	lifted_at: number | bigint | string | null;
}

interface SubjectKeyRow {
	id: string;
	tenant_id: string;
	subject: string | null;
	subject_marker: string | null;
	material: string | null;
	sealed_at: number | bigint | string;
	destroyed_at: number | bigint | string | null;
}

const SUBJECT_KEY_COLUMNS = `id, tenant_id, subject, subject_marker, material,
	 sealed_at, destroyed_at`;

interface ErasureRunRow {
	id: string;
	tenant_id: string;
	subject: string | null;
	subject_marker: string;
	status: ErasureRunStatus;
	dry_run: number | bigint | string;
	destroy_key: number | bigint | string;
	requested_by: string;
	output_directory: string | null;
	workspace_slug: string | null;
	workspace_name: string | null;
	classes: number | bigint | string;
	row_count: number | bigint | string;
	certificate_path: string | null;
	outcome_json: string | null;
	reason: string | null;
	started_at: number | bigint | string;
	completed_at: number | bigint | string | null;
}

const ERASURE_RUN_COLUMNS = `id, tenant_id, subject, subject_marker, status,
	 dry_run, destroy_key, requested_by, output_directory, workspace_slug,
	 workspace_name, classes, row_count, certificate_path, outcome_json, reason,
	 started_at, completed_at`;

interface ExportRunRow {
	id: string;
	tenant_id: string;
	format_version: string;
	status: ExportStatus;
	dry_run: number | bigint | string;
	classes: number | bigint | string;
	row_count: number | bigint | string;
	archive_digest: string | null;
	requested_by: string;
	reason: string | null;
	output_directory: string | null;
	archive_path: string | null;
	workspace_slug: string | null;
	workspace_name: string | null;
	summary_json: string | null;
	started_at: number | bigint | string;
	completed_at: number | bigint | string | null;
}

interface AuditEventRow {
	id: string;
	tenant_id: string;
	sequence: number | bigint | string;
	actor_id: string;
	action: string;
	subject_type: AuditSubjectType;
	subject_id: string;
	metadata_json: string;
	occurred_at: number | bigint | string;
	previous_hash: string | null;
	event_hash: string;
	subject_key_id: string | null;
	sealed_payload: string | null;
	seal_format: string | null;
}

/**
 * The event format this build writes. A stored row that carries it was written
 * by a build that seals a person's fields; a row without it predates the marker
 * and verify reports it as plaintext.
 */
export const AUDIT_EVENT_FORMAT = 'audit-event/1';

const ANCHOR_COLUMNS = `id, tenant_id, anchor_sequence, from_sequence, to_sequence,
	 row_count, first_occurred_at, last_occurred_at, segment_hash,
	 previous_anchor_hash, anchor_hash, signature, key_id, segment_file,
	 sealed_by, sealed_at`;

const HOLD_COLUMNS = `id, tenant_id, scope_kind, account_id, class_id, from_at,
	 to_at, reason, status, placed_by, placed_at, lifted_by, lift_reason,
	 lifted_at`;

const DATA_CLASS_COLUMNS = `id, tenant_id, class_id, module_id, label, exportable,
	 sweepable, default_retention_days, retention_mode, retention_days,
	 last_swept_at, created_at, updated_at`;

/* Queries stay explicit. Values always travel in the adapter's parameter
   channel; nothing from a request is concatenated into SQL. */
const SQL = {
	listDataClasses: `SELECT ${DATA_CLASS_COLUMNS} FROM audit_data_classes
	 WHERE tenant_id = $1 ORDER BY module_id, class_id`,
	getDataClass: `SELECT ${DATA_CLASS_COLUMNS} FROM audit_data_classes
	 WHERE tenant_id = $1 AND class_id = $2`,
	setRetention: `UPDATE audit_data_classes
	 SET retention_mode = $3, retention_days = $4, updated_at = $5
	 WHERE tenant_id = $1 AND class_id = $2
	 RETURNING ${DATA_CLASS_COLUMNS}`,
	stampSwept: `UPDATE audit_data_classes SET last_swept_at = $3, updated_at = $3
	 WHERE tenant_id = $1 AND class_id = $2`,
	/* Read through the cross-tenant background lease; the class is read again
	   under the workspace this returned before a single row is removed. */
	listDueDataClasses: `SELECT tenant_id, class_id, last_swept_at
	 FROM audit_data_classes
	 WHERE sweepable = 1
	   AND (last_swept_at IS NULL OR last_swept_at <= $1)
	   AND ((retention_mode = 'days' AND retention_days IS NOT NULL)
	     OR (retention_mode = 'default' AND default_retention_days IS NOT NULL))
	 ORDER BY last_swept_at NULLS FIRST, tenant_id, class_id
	 LIMIT $2`,

	insertSweepRun: `INSERT INTO audit_sweep_runs
	 (id, tenant_id, class_id, cutoff, removed, status, reason, held_back,
	  occurred_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
	listSweepRuns: `SELECT * FROM audit_sweep_runs
	 WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
	 ORDER BY occurred_at DESC, id
	 LIMIT $3`,
	latestSweepRun: `SELECT * FROM audit_sweep_runs
	 WHERE tenant_id = $1 AND class_id = $2
	 ORDER BY occurred_at DESC, id
	 LIMIT 1`,

	insertExportRun: `INSERT INTO audit_export_runs
	 (id, tenant_id, format_version, status, classes, row_count, archive_digest,
	  requested_by, started_at, completed_at, dry_run, output_directory,
	  workspace_slug, workspace_name)
	 VALUES ($1, $2, $3, 'started', 0, 0, NULL, $4, $5, NULL, $6, $7, $8, $9)`,
	finishExportRun: `UPDATE audit_export_runs
	 SET status = $3, classes = $4, row_count = $5, archive_digest = $6,
	     archive_path = $7, reason = $8, summary_json = $9, completed_at = $10
	 WHERE tenant_id = $1 AND id = $2 AND status = 'started'
	 RETURNING *`,
	getExportRun: `SELECT * FROM audit_export_runs
	 WHERE tenant_id = $1 AND id = $2`,
	/* Read through the cross-tenant background lease; the run is claimed and
	   performed under the workspace this returned. */
	listPendingExportRuns: `SELECT tenant_id, id, started_at
	 FROM audit_export_runs
	 WHERE status = 'started'
	 ORDER BY started_at, tenant_id, id
	 LIMIT $1`,
	/* One statement, so two platform processes cannot both take one run. A
	   claim older than the lease belonged to a process that is gone. */
	claimExportRun: `UPDATE audit_export_runs SET claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2 AND status = 'started'
	   AND (claimed_at IS NULL OR claimed_at <= $4)
	 RETURNING *`,
	listExportRuns: `SELECT * FROM audit_export_runs
	 WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
	 ORDER BY started_at DESC, id
	 LIMIT $3`,

	/* Two writers appending to one workspace would both read the same newest
	   sequence and the second insert would be refused by the unique constraint,
	   so the chain never forks but the loser loses its event. The lock is taken
	   on the workspace alone, is held for the transaction, and is released with
	   it however the transaction ends. */
	lockTenantChain: `SELECT pg_advisory_xact_lock(hashtext($1))`,
	latestAuditEvent: `SELECT sequence, event_hash FROM audit_events
	 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
	insertAuditEvent: `INSERT INTO audit_events
	 (id, tenant_id, sequence, actor_id, action, subject_type, subject_id,
	  metadata_json, occurred_at, previous_hash, event_hash, subject_key_id,
	  sealed_payload, seal_format)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
	listAuditEvents: `SELECT * FROM audit_events
	 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT $2`,

	/* Keyset walks for the export. Ordering by the primary key is what makes a
	   page boundary stable while rows are still being written behind it. */
	exportAuditEvents: `SELECT * FROM audit_events
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
	exportSweepRuns: `SELECT * FROM audit_sweep_runs
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
	exportExportRuns: `SELECT * FROM audit_export_runs
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,

	/* The sealing walk. Ordering by the sequence the chain already carries is
	   what makes a segment a range rather than a second ordering to maintain. */
	sealAuditEvents: `SELECT * FROM audit_events
	 WHERE tenant_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`,
	countAuditEventsBefore: `SELECT count(*) AS total FROM audit_events
	 WHERE tenant_id = $1 AND occurred_at < $2
	   AND ($3::bigint IS NULL OR sequence <= $3)`,
	/* Bounded by the sealed sequence, so retention can never remove a link no
	   segment file holds. The inner select is what applies the batch limit. */
	deleteAuditEventsBefore: `DELETE FROM audit_events WHERE id IN (
	   SELECT id FROM audit_events
	   WHERE tenant_id = $1 AND occurred_at < $2 AND sequence <= $3
	   ORDER BY sequence LIMIT $4)`,
	deleteSweepRunsBefore: `DELETE FROM audit_sweep_runs WHERE id IN (
	   SELECT id FROM audit_sweep_runs
	   WHERE tenant_id = $1 AND occurred_at < $2
	   ORDER BY occurred_at LIMIT $3)`,
	/* A run the platform has not answered is left alone whatever its age: the
	   command that recorded it is still polling the row. */
	deleteExportRunsBefore: `DELETE FROM audit_export_runs WHERE id IN (
	   SELECT id FROM audit_export_runs
	   WHERE tenant_id = $1 AND started_at < $2 AND status <> 'started'
	   ORDER BY started_at LIMIT $3)`,

	insertAnchor: `INSERT INTO audit_anchors (${ANCHOR_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
	latestAnchor: `SELECT ${ANCHOR_COLUMNS} FROM audit_anchors
	 WHERE tenant_id = $1 ORDER BY anchor_sequence DESC LIMIT 1`,
	listAnchors: `SELECT ${ANCHOR_COLUMNS} FROM audit_anchors
	 WHERE tenant_id = $1 ORDER BY anchor_sequence DESC LIMIT $2`,
	getAnchor: `SELECT ${ANCHOR_COLUMNS} FROM audit_anchors
	 WHERE tenant_id = $1 AND id = $2`,
	/* The stored signature is the optimistic check: an anchor another process
	   re-signed in between keeps its own row instead of being written twice. */
	resignAnchor: `UPDATE audit_anchors SET signature = $3, key_id = $4
	 WHERE tenant_id = $1 AND id = $2 AND signature = $5`,
	countAnchorsByKey: `SELECT key_id, count(*) AS anchors FROM audit_anchors
	 GROUP BY key_id ORDER BY key_id`,
	/* Paged by primary key: an anchor the optimistic update skipped stays
	   stale, so a query that only asked for stale rows would return it for ever. */
	anchorsNotOnKey: `SELECT tenant_id, id, key_id FROM audit_anchors
	 WHERE key_id <> $1 AND id > $2 ORDER BY id LIMIT $3`,

	insertHold: `INSERT INTO audit_legal_holds (${HOLD_COLUMNS})
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, NULL, NULL, NULL)`,
	liftHold: `UPDATE audit_legal_holds
	 SET status = 'lifted', lifted_by = $3, lift_reason = $4, lifted_at = $5
	 WHERE tenant_id = $1 AND id = $2 AND status = 'active'
	 RETURNING ${HOLD_COLUMNS}`,
	getHold: `SELECT ${HOLD_COLUMNS} FROM audit_legal_holds
	 WHERE tenant_id = $1 AND id = $2`,
	listHolds: `SELECT ${HOLD_COLUMNS} FROM audit_legal_holds
	 WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
	 ORDER BY placed_at DESC, id
	 LIMIT $3`,
	listActiveHolds: `SELECT ${HOLD_COLUMNS} FROM audit_legal_holds
	 WHERE tenant_id = $1 AND status = 'active'
	 ORDER BY placed_at DESC, id
	 LIMIT $2`,

	getSubjectKey: `SELECT ${SUBJECT_KEY_COLUMNS}
	 FROM audit_subject_keys WHERE tenant_id = $1 AND subject = $2`,
	/* The marker outlives the account, so this is the only way to find a key
	   that was destroyed, and the only way to know a subject once had one. */
	getSubjectKeyByMarker: `SELECT ${SUBJECT_KEY_COLUMNS}
	 FROM audit_subject_keys WHERE tenant_id = $1 AND subject_marker = $2`,
	insertSubjectKey: `INSERT INTO audit_subject_keys
	 (id, tenant_id, subject, subject_marker, material, sealed_at, destroyed_at)
	 VALUES ($1, $2, $3, $4, $5, $6, NULL)
	 ON CONFLICT DO NOTHING`,
	/* The material and the account go together: what is left names nobody and
	   opens nothing, and the events that point at it keep a target. The marker
	   stays, so the tombstone is still findable and no second key is ever made
	   for the subject it belonged to. */
	destroySubjectKey: `UPDATE audit_subject_keys
	 SET subject = NULL, material = NULL, destroyed_at = $3
	 WHERE tenant_id = $1 AND subject = $2
	 RETURNING ${SUBJECT_KEY_COLUMNS}`,
	listSubjectKeys: `SELECT ${SUBJECT_KEY_COLUMNS}
	 FROM audit_subject_keys WHERE tenant_id = $1
	 ORDER BY sealed_at DESC, id LIMIT $2`,

	insertErasureRun: `INSERT INTO audit_erasure_runs
	 (id, tenant_id, subject, subject_marker, status, dry_run, destroy_key,
	  requested_by, output_directory, workspace_slug, workspace_name, classes,
	  row_count, certificate_path, outcome_json, reason, claimed_at, started_at,
	  completed_at)
	 VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $8, $9, $10, 0, 0, NULL,
	         NULL, NULL, NULL, $11, NULL)`,
	/* The subject is blanked in the same statement that finishes the run: a
	   history of erasures must not be a list of the people who asked. */
	finishErasureRun: `UPDATE audit_erasure_runs
	 SET status = $3, classes = $4, row_count = $5, certificate_path = $6,
	     outcome_json = $7, reason = $8, completed_at = $9, subject = NULL
	 WHERE tenant_id = $1 AND id = $2 AND status = 'requested'
	 RETURNING ${ERASURE_RUN_COLUMNS}`,
	getErasureRun: `SELECT ${ERASURE_RUN_COLUMNS} FROM audit_erasure_runs
	 WHERE tenant_id = $1 AND id = $2`,
	listPendingErasureRuns: `SELECT tenant_id, id, started_at
	 FROM audit_erasure_runs
	 WHERE status = 'requested'
	 ORDER BY started_at, tenant_id, id
	 LIMIT $1`,
	claimErasureRun: `UPDATE audit_erasure_runs SET claimed_at = $3
	 WHERE tenant_id = $1 AND id = $2 AND status = 'requested'
	   AND (claimed_at IS NULL OR claimed_at <= $4)
	 RETURNING ${ERASURE_RUN_COLUMNS}`,
	listErasureRuns: `SELECT ${ERASURE_RUN_COLUMNS} FROM audit_erasure_runs
	 WHERE tenant_id = $1 ORDER BY started_at DESC, id LIMIT $2`,
	exportLegalHolds: `SELECT ${HOLD_COLUMNS} FROM audit_legal_holds
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
	exportErasureRuns: `SELECT ${ERASURE_RUN_COLUMNS} FROM audit_erasure_runs
	 WHERE tenant_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
	countHoldsForAccount: `SELECT COUNT(*) AS total FROM audit_legal_holds
	 WHERE tenant_id = $1 AND account_id = $2`,
} as const;

/** Classes one upsert statement carries, so a statement stays a bounded size. */
const DATA_CLASS_UPSERT_CHUNK = 100;

/* The facts come from the registry, the period and the sweep stamp from the
   workspace, so a refresh overwrites the first group and never the second. One
   statement per chunk rather than one per class: a deployment declaring a
   hundred classes paid a hundred round trips on every registry read. */
function upsertDataClasses(count: number): string {
	const rows: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const base = index * 9;
		rows.push(
			`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},` +
				` $${base + 6}, $${base + 7}, $${base + 8}, 'default', NULL, NULL,` +
				` $${base + 9}, $${base + 9})`,
		);
	}
	return `INSERT INTO audit_data_classes (${DATA_CLASS_COLUMNS})
	 VALUES ${rows.join(', ')}
	 ON CONFLICT (tenant_id, class_id) DO UPDATE SET
	   module_id = EXCLUDED.module_id,
	   label = EXCLUDED.label,
	   exportable = EXCLUDED.exportable,
	   sweepable = EXCLUDED.sweepable,
	   default_retention_days = EXCLUDED.default_retention_days,
	   updated_at = EXCLUDED.updated_at
	 WHERE audit_data_classes.label IS DISTINCT FROM EXCLUDED.label
	    OR audit_data_classes.module_id IS DISTINCT FROM EXCLUDED.module_id
	    OR audit_data_classes.exportable IS DISTINCT FROM EXCLUDED.exportable
	    OR audit_data_classes.sweepable IS DISTINCT FROM EXCLUDED.sweepable
	    OR audit_data_classes.default_retention_days
	       IS DISTINCT FROM EXCLUDED.default_retention_days`;
}

/**
 * Whether the workspace already holds every declared class with the facts the
 * registry declares now. O(classes) over one page the caller has read anyway,
 * and it is what keeps a registry read a read: only a composition change or a
 * workspace that has never been materialised opens the write.
 */
function dataClassesCarry(
	stored: readonly AuditDataClass[],
	facts: readonly DataClassFacts[],
): boolean {
	if (stored.length < facts.length) return false;
	const byClassId = new Map(stored.map((entry) => [entry.classId, entry]));
	return facts.every((fact) => {
		const record = byClassId.get(fact.classId);
		return (
			record !== undefined &&
			record.moduleId === fact.moduleId &&
			record.label === fact.label &&
			record.exportable === fact.exportable &&
			record.sweepable === fact.sweepable &&
			record.defaultRetentionDays === fact.defaultRetentionDays
		);
	});
}

/* One page of events names at most this many distinct subject keys, so the
   lookup that opens them is one statement with bound placeholders. */
function subjectKeysByIds(count: number): string {
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 2}`,
	).join(', ');
	return `SELECT id, material FROM audit_subject_keys
	 WHERE tenant_id = $1 AND id IN (${placeholders})`;
}

/* PostgreSQL returns BIGINT as a string, so every integer read crosses this
   instead of trusting the driver's representation. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The audit database returned an invalid ${field}.`);
	}
	return normalized;
}

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

function effectiveRetentionDays(
	mode: RetentionMode,
	workspaceDays: number | null,
	defaultDays: number | null,
): number | null {
	if (mode === 'none') return null;
	return mode === 'days' ? workspaceDays : defaultDays;
}

function dataClassFromRow(row: DataClassRow): AuditDataClass {
	const defaultRetentionDays = optionalInteger(
		row.default_retention_days,
		'retention period',
	);
	const retentionDays = optionalInteger(row.retention_days, 'retention period');
	return {
		id: row.id,
		tenantId: row.tenant_id,
		classId: row.class_id,
		moduleId: row.module_id,
		label: row.label,
		exportable: integer(row.exportable, 'exportable flag') === 1,
		sweepable: integer(row.sweepable, 'sweepable flag') === 1,
		defaultRetentionDays,
		retentionMode: row.retention_mode,
		retentionDays,
		effectiveRetentionDays: effectiveRetentionDays(
			row.retention_mode,
			retentionDays,
			defaultRetentionDays,
		),
		lastSweptAt: optionalInteger(row.last_swept_at, 'timestamp'),
		createdAt: integer(row.created_at, 'timestamp'),
		updatedAt: integer(row.updated_at, 'timestamp'),
	};
}

function sweepRunFromRow(row: SweepRunRow): AuditSweepRun {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		classId: row.class_id,
		cutoff: integer(row.cutoff, 'timestamp'),
		removed: integer(row.removed, 'row count'),
		status: row.status,
		reason: row.reason,
		heldBack: optionalInteger(row.held_back, 'row count'),
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

function anchorFromRow(row: AnchorRow): AuditChainAnchor {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		anchorSequence: integer(row.anchor_sequence, 'sequence'),
		fromSequence: integer(row.from_sequence, 'sequence'),
		toSequence: integer(row.to_sequence, 'sequence'),
		rowCount: integer(row.row_count, 'row count'),
		firstOccurredAt: integer(row.first_occurred_at, 'timestamp'),
		lastOccurredAt: integer(row.last_occurred_at, 'timestamp'),
		segmentHash: row.segment_hash,
		previousAnchorHash: row.previous_anchor_hash,
		anchorHash: row.anchor_hash,
		signature: row.signature,
		keyId: row.key_id,
		segmentFile: row.segment_file,
		sealedBy: row.sealed_by,
		sealedAt: integer(row.sealed_at, 'timestamp'),
	};
}

function holdFromRow(row: LegalHoldRow): AuditLegalHold {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		scopeKind: row.scope_kind,
		accountId: row.account_id,
		classId: row.class_id,
		fromAt: optionalInteger(row.from_at, 'timestamp'),
		toAt: optionalInteger(row.to_at, 'timestamp'),
		reason: row.reason,
		status: row.status,
		placedBy: row.placed_by,
		placedAt: integer(row.placed_at, 'timestamp'),
		liftedBy: row.lifted_by,
		liftReason: row.lift_reason,
		liftedAt: optionalInteger(row.lifted_at, 'timestamp'),
	};
}

function erasureRunFromRow(row: ErasureRunRow): AuditErasureRun {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		subject: row.subject,
		subjectMarker: row.subject_marker,
		status: row.status,
		dryRun: integer(row.dry_run, 'dry run flag') === 1,
		destroyKey: integer(row.destroy_key, 'destroy key flag') === 1,
		requestedBy: row.requested_by,
		outputDirectory: row.output_directory,
		workspaceSlug: row.workspace_slug,
		workspaceName: row.workspace_name,
		classes: integer(row.classes, 'class count'),
		rows: integer(row.row_count, 'row count'),
		certificatePath: row.certificate_path,
		outcome: parsedOutcome(row.outcome_json),
		reason: row.reason,
		startedAt: integer(row.started_at, 'timestamp'),
		completedAt: optionalInteger(row.completed_at, 'timestamp'),
	};
}

/* A row edited outside the module carries no readable outcome; the certificate
   is what proves what was removed, not this view of it. */
function parsedOutcome(
	value: string | null,
): readonly ErasureClassOutcome[] | null {
	if (value === null) return null;
	try {
		const parsed = JSON.parse(value) as ErasureClassOutcome[];
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function subjectKeyFromRow(row: SubjectKeyRow): AuditSubjectKey {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		subject: row.subject,
		subjectMarker: row.subject_marker,
		state: row.destroyed_at === null ? 'active' : 'destroyed',
		sealedAt: integer(row.sealed_at, 'timestamp'),
		destroyedAt: optionalInteger(row.destroyed_at, 'timestamp'),
	};
}

function exportRunFromRow(row: ExportRunRow): AuditExportRun {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		formatVersion: row.format_version,
		status: row.status,
		dryRun: integer(row.dry_run, 'dry run flag') === 1,
		classes: integer(row.classes, 'class count'),
		rows: integer(row.row_count, 'row count'),
		archiveDigest: row.archive_digest,
		requestedBy: row.requested_by,
		reason: row.reason,
		outputDirectory: row.output_directory,
		archivePath: row.archive_path,
		workspaceSlug: row.workspace_slug,
		workspaceName: row.workspace_name,
		summary: parsedSummary(row.summary_json),
		startedAt: integer(row.started_at, 'timestamp'),
		completedAt: optionalInteger(row.completed_at, 'timestamp'),
	};
}

/* A row edited outside the module carries no readable summary; the archive
   digest is what proves what was written, not this view of it. */
function parsedSummary(value: string | null): ExportRunSummary | null {
	if (value === null) return null;
	try {
		const parsed = JSON.parse(value) as ExportRunSummary;
		return typeof parsed === 'object' &&
			parsed !== null &&
			Array.isArray(parsed.classes) &&
			Array.isArray(parsed.exclusions)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function storedEventFromRow(row: AuditEventRow): StoredAuditEvent {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		sequence: integer(row.sequence, 'sequence'),
		actorId: row.actor_id,
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadataJson: row.metadata_json,
		occurredAt: integer(row.occurred_at, 'timestamp'),
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
		subjectKeyId: row.subject_key_id,
		sealedPayload: row.sealed_payload,
		sealFormat: row.seal_format,
	};
}

/**
 * The hash of one stored event. A sealed row keeps the marker in the actor and
 * subject columns and the envelope beside them, and the envelope stands in the
 * place the metadata holds for a plaintext row, so the hash of any row is a
 * function of its stored bytes alone: destroying a subject key never touches
 * the chain.
 */
export function storedAuditEventHash(event: StoredAuditEvent): string {
	return auditEventHash({
		id: event.id,
		tenantId: event.tenantId,
		sequence: event.sequence,
		actorId: event.actorId,
		action: event.action,
		subjectType: event.subjectType,
		subjectId: event.subjectId,
		metadataJson: event.sealedPayload ?? event.metadataJson,
		occurredAt: event.occurredAt,
		previousHash: event.previousHash,
		sealed: event.sealedPayload !== null,
		subjectKeyId: event.subjectKeyId,
		sealFormat: event.sealFormat,
	});
}

interface SealedEventContent {
	readonly actorId: string;
	readonly subjectId: string;
	readonly metadata: Record<string, unknown>;
}

function auditEventFromRow(
	row: AuditEventRow,
	keys: ReadonlyMap<string, Buffer>,
): AuditEvent {
	const sequence = integer(row.sequence, 'sequence');
	const base = {
		id: row.id,
		tenantId: row.tenant_id,
		sequence,
		action: row.action,
		subjectType: row.subject_type,
		occurredAt: integer(row.occurred_at, 'timestamp'),
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
		sealed: row.sealed_payload !== null,
		subjectKeyId: row.subject_key_id,
	};
	if (row.sealed_payload === null) {
		return {
			...base,
			actorId: row.actor_id,
			subjectId: row.subject_id,
			metadata: parsedMetadata(row.metadata_json),
			readable: true,
		};
	}
	const key = row.subject_key_id ? keys.get(row.subject_key_id) : undefined;
	const opened = key
		? openSubjectPayload(
				key,
				subjectSealContext(row.tenant_id, row.id),
				row.sealed_payload,
			)
		: null;
	const content = opened === null ? null : parsedSealedContent(opened);
	return {
		...base,
		actorId: content?.actorId ?? AUDIT_SEALED_MARKER,
		subjectId: content?.subjectId ?? AUDIT_SEALED_MARKER,
		metadata: content?.metadata ?? {},
		readable: content !== null,
	};
}

/* A destroyed key answers nothing and a corrupt envelope answers nothing; both
   are the same to a reader, and the row still proves the event existed. */
function parsedSealedContent(value: string): SealedEventContent | null {
	try {
		const parsed = JSON.parse(value) as SealedEventContent;
		return typeof parsed === 'object' &&
			parsed !== null &&
			typeof parsed.actorId === 'string' &&
			typeof parsed.subjectId === 'string'
			? {
					actorId: parsed.actorId,
					subjectId: parsed.subjectId,
					metadata:
						typeof parsed.metadata === 'object' && parsed.metadata !== null
							? parsed.metadata
							: {},
				}
			: null;
	} catch {
		return null;
	}
}

function parsedMetadata(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === 'object' &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		/* A row edited outside the module carries no readable metadata; the hash
		   over the stored text is what proves the chain, not this view of it. */
		return {};
	}
}

/* The hash covers the serialized metadata, not an object, so two events with
   the same fields in a different key order still seal the same bytes. */
export function stableMetadata(
	metadata: Readonly<Record<string, unknown>>,
): string {
	const sorted = Object.keys(metadata).sort();
	return JSON.stringify(
		Object.fromEntries(sorted.map((key) => [key, metadata[key]])),
	);
}

/**
 * Every stored column of the row is in the preimage. The identifier, the key the
 * row points at, the format that wrote it and whether it is sealed are part of
 * it too: without them a row could be repointed at another subject key, or read
 * as plaintext where it was sealed, and still match its own hash.
 */
export function auditEventHash(input: {
	readonly id: string;
	readonly tenantId: string;
	readonly sequence: number;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly metadataJson: string;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly sealed: boolean;
	readonly subjectKeyId: string | null;
	readonly sealFormat: string | null;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				input.id,
				input.tenantId,
				input.sequence,
				input.actorId,
				input.action,
				input.subjectType,
				input.subjectId,
				input.metadataJson,
				input.occurredAt,
				input.previousHash,
				input.sealed,
				input.subjectKeyId,
				input.sealFormat,
			]),
		)
		.digest('hex');
}

export class DatabaseAuditRepository implements AuditRepository {
	constructor(private readonly handles: AuditDatabaseHandles) {}

	async #read<Row extends object>(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly Row[]> {
		const result = await this.handles.runtime.transaction(
			(transaction) => transaction.query<Row>(statement),
			{ access: 'read', tenantId },
		);
		return result.rows;
	}

	async #write(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<number> {
		const result = await this.handles.runtime.transaction(
			(transaction) => transaction.execute(statement),
			{ access: 'write', tenantId },
		);
		return result.affectedRows;
	}

	async materializeDataClasses(
		tenantId: string,
		facts: readonly DataClassFacts[],
		now: number,
	): Promise<readonly AuditDataClass[]> {
		/* The declarations are a property of the composition, so a workspace whose
		   rows already carry them has nothing to write and this call is the read
		   it answers with. Writing on every read put a write transaction behind
		   the registry screen, which a GET must not open. */
		const stored = await this.listDataClasses(tenantId);
		if (dataClassesCarry(stored, facts)) return stored;
		/* One transaction: a workspace reading the registry twice in parallel
		   cannot see half of the classes it is about to be told exist. */
		const rows = await this.handles.runtime.transaction(
			async (transaction) => {
				for (
					let offset = 0;
					offset < facts.length;
					offset += DATA_CLASS_UPSERT_CHUNK
				) {
					const chunk = facts.slice(offset, offset + DATA_CLASS_UPSERT_CHUNK);
					await transaction.execute({
						text: upsertDataClasses(chunk.length),
						parameters: chunk.flatMap((fact) => [
							randomUUID(),
							tenantId,
							fact.classId,
							fact.moduleId,
							fact.label,
							fact.exportable ? 1 : 0,
							fact.sweepable ? 1 : 0,
							fact.defaultRetentionDays,
							now,
						]),
					});
				}
				return transaction.query<DataClassRow>({
					text: SQL.listDataClasses,
					parameters: [tenantId],
				});
			},
			{ access: 'write', tenantId },
		);
		return rows.rows.map(dataClassFromRow);
	}

	async listDataClasses(tenantId: string): Promise<readonly AuditDataClass[]> {
		const rows = await this.#read<DataClassRow>(tenantId, {
			text: SQL.listDataClasses,
			parameters: [tenantId],
		});
		return rows.map(dataClassFromRow);
	}

	async getDataClass(
		tenantId: string,
		classId: string,
	): Promise<AuditDataClass | null> {
		const rows = await this.#read<DataClassRow>(tenantId, {
			text: SQL.getDataClass,
			parameters: [tenantId, classId],
		});
		return rows[0] ? dataClassFromRow(rows[0]) : null;
	}

	async setRetention(
		tenantId: string,
		classId: string,
		mode: RetentionMode,
		days: number | null,
		now: number,
	): Promise<AuditDataClass | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<DataClassRow>({
					text: SQL.setRetention,
					parameters: [tenantId, classId, mode, days, now],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
		return row ? dataClassFromRow(row) : null;
	}

	async stampSwept(
		tenantId: string,
		classId: string,
		sweptAt: number,
	): Promise<boolean> {
		const affected = await this.#write(tenantId, {
			text: SQL.stampSwept,
			parameters: [tenantId, classId, sweptAt],
		});
		return affected === 1;
	}

	async listDueDataClasses(
		staleBefore: number,
		limit: number,
	): Promise<readonly DataClassRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			class_id: string;
			last_swept_at: number | bigint | string | null;
		}>({
			text: SQL.listDueDataClasses,
			parameters: [staleBefore, limit],
		});
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			classId: row.class_id,
			lastSweptAt: optionalInteger(row.last_swept_at, 'timestamp'),
		}));
	}

	async appendSweepRun(input: AppendSweepRunInput): Promise<AuditSweepRun> {
		const record: AuditSweepRun = { ...input, id: randomUUID() };
		await this.#write(input.tenantId, {
			text: SQL.insertSweepRun,
			parameters: [
				record.id,
				record.tenantId,
				record.classId,
				record.cutoff,
				record.removed,
				record.status,
				record.reason,
				record.heldBack,
				record.occurredAt,
			],
		});
		return record;
	}

	async listSweepRuns(
		tenantId: string,
		status: SweepStatus | undefined,
		limit: number,
	): Promise<readonly AuditSweepRun[]> {
		const rows = await this.#read<SweepRunRow>(tenantId, {
			text: SQL.listSweepRuns,
			parameters: [tenantId, status ?? null, limit],
		});
		return rows.map(sweepRunFromRow);
	}

	async latestSweepRun(
		tenantId: string,
		classId: string,
	): Promise<AuditSweepRun | null> {
		const rows = await this.#read<SweepRunRow>(tenantId, {
			text: SQL.latestSweepRun,
			parameters: [tenantId, classId],
		});
		return rows[0] ? sweepRunFromRow(rows[0]) : null;
	}

	async startExportRun(input: StartExportRunInput): Promise<AuditExportRun> {
		const record: AuditExportRun = {
			id: randomUUID(),
			tenantId: input.tenantId,
			formatVersion: input.formatVersion,
			status: 'started',
			dryRun: input.dryRun,
			classes: 0,
			rows: 0,
			archiveDigest: null,
			requestedBy: input.requestedBy,
			reason: null,
			outputDirectory: input.outputDirectory,
			archivePath: null,
			workspaceSlug: input.workspaceSlug,
			workspaceName: input.workspaceName,
			summary: null,
			startedAt: input.startedAt,
			completedAt: null,
		};
		await this.#write(input.tenantId, {
			text: SQL.insertExportRun,
			parameters: [
				record.id,
				record.tenantId,
				record.formatVersion,
				record.requestedBy,
				record.startedAt,
				record.dryRun ? 1 : 0,
				record.outputDirectory,
				record.workspaceSlug,
				record.workspaceName,
			],
		});
		return record;
	}

	async finishExportRun(
		input: FinishExportRunInput,
	): Promise<AuditExportRun | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<ExportRunRow>({
					text: SQL.finishExportRun,
					parameters: [
						input.tenantId,
						input.id,
						input.status,
						input.classes,
						input.rows,
						input.archiveDigest,
						input.archivePath,
						input.reason,
						input.summary === null ? null : JSON.stringify(input.summary),
						input.completedAt,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? exportRunFromRow(row) : null;
	}

	async getExportRun(
		tenantId: string,
		id: string,
	): Promise<AuditExportRun | null> {
		const rows = await this.#read<ExportRunRow>(tenantId, {
			text: SQL.getExportRun,
			parameters: [tenantId, id],
		});
		return rows[0] ? exportRunFromRow(rows[0]) : null;
	}

	async listPendingExportRuns(
		limit: number,
	): Promise<readonly ExportRunRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			id: string;
			started_at: number | bigint | string;
		}>({
			text: SQL.listPendingExportRuns,
			parameters: [limit],
		});
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			startedAt: integer(row.started_at, 'timestamp'),
		}));
	}

	async claimExportRun(
		input: ClaimExportRunInput,
	): Promise<AuditExportRun | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<ExportRunRow>({
					text: SQL.claimExportRun,
					parameters: [
						input.tenantId,
						input.id,
						input.claimedAt,
						input.staleBefore,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? exportRunFromRow(row) : null;
	}

	async listExportRuns(
		tenantId: string,
		status: ExportStatus | undefined,
		limit: number,
	): Promise<readonly AuditExportRun[]> {
		const rows = await this.#read<ExportRunRow>(tenantId, {
			text: SQL.listExportRuns,
			parameters: [tenantId, status ?? null, limit],
		});
		return rows.map(exportRunFromRow);
	}

	/* The previous hash is read and the next event written inside one
	   transaction, under the workspace's own advisory lock, so two writers
	   neither fork the chain nor race for one sequence: the second waits and
	   appends after the first. The subject key is taken in the same
	   transaction, so a row is never written naming a key that does not exist. */
	async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEvent> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				await transaction.execute({
					text: SQL.lockTenantChain,
					parameters: [input.tenantId],
				});
				const latest = await transaction.query<{
					sequence: number | bigint | string;
					event_hash: string;
				}>({
					text: SQL.latestAuditEvent,
					parameters: [input.tenantId],
				});
				const previous = latest.rows[0];
				const sequence =
					(previous ? integer(previous.sequence, 'sequence') : 0) + 1;
				const previousHash = previous?.event_hash ?? null;
				const id = randomUUID();
				const subject = input.subjectAccountId?.trim();
				const key = subject
					? await subjectKeyIn(
							transaction,
							input.tenantId,
							subject,
							input.occurredAt,
						)
					: null;
				const sealedPayload = key
					? sealSubjectPayload(
							key.key,
							subjectSealContext(input.tenantId, id),
							JSON.stringify({
								actorId: input.actorId,
								subjectId: input.subjectId,
								metadata: input.metadata,
							}),
						)
					: null;
				const metadataJson = key ? '{}' : stableMetadata(input.metadata);
				const stored: StoredAuditEvent = {
					id,
					tenantId: input.tenantId,
					sequence,
					actorId: key ? AUDIT_SEALED_MARKER : input.actorId,
					action: input.action,
					subjectType: input.subjectType,
					subjectId: key ? AUDIT_SEALED_MARKER : input.subjectId,
					metadataJson,
					occurredAt: input.occurredAt,
					previousHash,
					eventHash: '',
					subjectKeyId: key?.id ?? null,
					sealedPayload,
					sealFormat: AUDIT_EVENT_FORMAT,
				};
				const eventHash = storedAuditEventHash(stored);
				await transaction.execute({
					text: SQL.insertAuditEvent,
					parameters: [
						stored.id,
						stored.tenantId,
						stored.sequence,
						stored.actorId,
						stored.action,
						stored.subjectType,
						stored.subjectId,
						stored.metadataJson,
						stored.occurredAt,
						stored.previousHash,
						eventHash,
						stored.subjectKeyId,
						stored.sealedPayload,
						stored.sealFormat,
					] satisfies readonly DatabaseParameter[],
				});
				return {
					id: stored.id,
					tenantId: stored.tenantId,
					sequence,
					actorId: input.actorId,
					action: input.action,
					subjectType: input.subjectType,
					subjectId: input.subjectId,
					metadata: input.metadata,
					occurredAt: input.occurredAt,
					previousHash,
					eventHash,
					sealed: sealedPayload !== null,
					subjectKeyId: stored.subjectKeyId,
					readable: true,
				};
			},
			{ access: 'write', tenantId: input.tenantId },
		);
	}

	async exportAuditEventsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditEvent[]> {
		return this.#openedEvents(tenantId, {
			text: SQL.exportAuditEvents,
			parameters: [tenantId, afterId, limit],
		});
	}

	async exportSweepRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditSweepRun[]> {
		const rows = await this.#read<SweepRunRow>(tenantId, {
			text: SQL.exportSweepRuns,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(sweepRunFromRow);
	}

	async exportExportRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditExportRun[]> {
		const rows = await this.#read<ExportRunRow>(tenantId, {
			text: SQL.exportExportRuns,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(exportRunFromRow);
	}

	async exportLegalHoldsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditLegalHold[]> {
		const rows = await this.#read<LegalHoldRow>(tenantId, {
			text: SQL.exportLegalHolds,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(holdFromRow);
	}

	async exportErasureRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditErasureRun[]> {
		const rows = await this.#read<ErasureRunRow>(tenantId, {
			text: SQL.exportErasureRuns,
			parameters: [tenantId, afterId, limit],
		});
		return rows.map(erasureRunFromRow);
	}

	async listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditEvent[]> {
		return this.#openedEvents(tenantId, {
			text: SQL.listAuditEvents,
			parameters: [tenantId, limit],
		});
	}

	/**
	 * Reads a page of events and the subject keys that page needs in the same
	 * transaction. Two statements per page rather than one per row, and no key
	 * is cached between calls: a key destroyed a moment ago must not open a row
	 * in a process that happened to read it earlier.
	 */
	async #openedEvents(
		tenantId: string,
		statement: DatabaseStatement,
	): Promise<readonly AuditEvent[]> {
		return this.handles.runtime.transaction(
			async (transaction) => {
				const rows = (await transaction.query<AuditEventRow>(statement)).rows;
				const ids = [
					...new Set(
						rows.flatMap((row) =>
							row.subject_key_id === null ? [] : [row.subject_key_id],
						),
					),
				];
				const keys = new Map<string, Buffer>();
				if (ids.length > 0) {
					const found = await transaction.query<{
						id: string;
						material: string | null;
					}>({
						text: subjectKeysByIds(ids.length),
						parameters: [tenantId, ...ids],
					});
					for (const row of found.rows) {
						if (row.material !== null) {
							keys.set(row.id, decodeSubjectKey(row.material));
						}
					}
				}
				return rows.map((row) => auditEventFromRow(row, keys));
			},
			{ access: 'read', tenantId },
		);
	}

	async sealAuditEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly StoredAuditEvent[]> {
		const rows = await this.#read<AuditEventRow>(tenantId, {
			text: SQL.sealAuditEvents,
			parameters: [tenantId, afterSequence, limit],
		});
		return rows.map(storedEventFromRow);
	}

	async countAuditEventsBefore(
		tenantId: string,
		cutoff: number,
		maxSequence: number | null,
	): Promise<number> {
		const rows = await this.#read<{ total: number | bigint | string }>(
			tenantId,
			{
				text: SQL.countAuditEventsBefore,
				parameters: [tenantId, cutoff, maxSequence],
			},
		);
		return integer(rows[0]?.total ?? 0, 'row count');
	}

	async deleteAuditEventsBefore(
		tenantId: string,
		cutoff: number,
		maxSequence: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, {
			text: SQL.deleteAuditEventsBefore,
			parameters: [tenantId, cutoff, maxSequence, limit],
		});
	}

	async deleteSweepRunsBefore(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, {
			text: SQL.deleteSweepRunsBefore,
			parameters: [tenantId, cutoff, limit],
		});
	}

	async deleteExportRunsBefore(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		return this.#write(tenantId, {
			text: SQL.deleteExportRunsBefore,
			parameters: [tenantId, cutoff, limit],
		});
	}

	async latestAnchor(tenantId: string): Promise<AuditChainAnchor | null> {
		const rows = await this.#read<AnchorRow>(tenantId, {
			text: SQL.latestAnchor,
			parameters: [tenantId],
		});
		return rows[0] ? anchorFromRow(rows[0]) : null;
	}

	async listAnchors(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditChainAnchor[]> {
		const rows = await this.#read<AnchorRow>(tenantId, {
			text: SQL.listAnchors,
			parameters: [tenantId, limit],
		});
		return rows.map(anchorFromRow);
	}

	async getAnchor(
		tenantId: string,
		id: string,
	): Promise<AuditChainAnchor | null> {
		const rows = await this.#read<AnchorRow>(tenantId, {
			text: SQL.getAnchor,
			parameters: [tenantId, id],
		});
		return rows[0] ? anchorFromRow(rows[0]) : null;
	}

	async insertAnchor(input: InsertAnchorInput): Promise<AuditChainAnchor> {
		const record: AuditChainAnchor = { ...input, id: randomUUID() };
		await this.#write(input.tenantId, {
			text: SQL.insertAnchor,
			parameters: [
				record.id,
				record.tenantId,
				record.anchorSequence,
				record.fromSequence,
				record.toSequence,
				record.rowCount,
				record.firstOccurredAt,
				record.lastOccurredAt,
				record.segmentHash,
				record.previousAnchorHash,
				record.anchorHash,
				record.signature,
				record.keyId,
				record.segmentFile,
				record.sealedBy,
				record.sealedAt,
			],
		});
		return record;
	}

	async resignAnchor(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly signature: string;
		readonly keyId: string;
		readonly expectedSignature: string;
	}): Promise<boolean> {
		const affected = await this.#write(input.tenantId, {
			text: SQL.resignAnchor,
			parameters: [
				input.tenantId,
				input.id,
				input.signature,
				input.keyId,
				input.expectedSignature,
			],
		});
		return affected === 1;
	}

	async countAnchorsByKey(): Promise<readonly AnchorKeyCount[]> {
		const result = await this.handles.background.query<{
			key_id: string;
			anchors: number | bigint | string;
		}>({ text: SQL.countAnchorsByKey });
		return result.rows.map((row) => ({
			keyId: row.key_id,
			anchors: integer(row.anchors, 'anchor count'),
		}));
	}

	async listAnchorsNotOnKey(
		keyId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AnchorRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			id: string;
			key_id: string;
		}>({
			text: SQL.anchorsNotOnKey,
			parameters: [keyId, afterId, limit],
		});
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			keyId: row.key_id,
		}));
	}

	async insertHold(input: InsertHoldInput): Promise<AuditLegalHold> {
		const record: AuditLegalHold = {
			...input,
			id: randomUUID(),
			status: 'active',
			liftedBy: null,
			liftReason: null,
			liftedAt: null,
		};
		await this.#write(input.tenantId, {
			text: SQL.insertHold,
			parameters: [
				record.id,
				record.tenantId,
				record.scopeKind,
				record.accountId,
				record.classId,
				record.fromAt,
				record.toAt,
				record.reason,
				record.placedBy,
				record.placedAt,
			],
		});
		return record;
	}

	async liftHold(input: LiftHoldRecordInput): Promise<AuditLegalHold | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<LegalHoldRow>({
					text: SQL.liftHold,
					parameters: [
						input.tenantId,
						input.id,
						input.liftedBy,
						input.liftReason,
						input.liftedAt,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? holdFromRow(row) : null;
	}

	async getHold(tenantId: string, id: string): Promise<AuditLegalHold | null> {
		const rows = await this.#read<LegalHoldRow>(tenantId, {
			text: SQL.getHold,
			parameters: [tenantId, id],
		});
		return rows[0] ? holdFromRow(rows[0]) : null;
	}

	async listHolds(
		tenantId: string,
		status: HoldStatus | undefined,
		limit: number,
	): Promise<readonly AuditLegalHold[]> {
		const rows = await this.#read<LegalHoldRow>(tenantId, {
			text: SQL.listHolds,
			parameters: [tenantId, status ?? null, limit],
		});
		return rows.map(holdFromRow);
	}

	async listActiveHolds(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditLegalHold[]> {
		const rows = await this.#read<LegalHoldRow>(tenantId, {
			text: SQL.listActiveHolds,
			parameters: [tenantId, limit],
		});
		return rows.map(holdFromRow);
	}

	async countHoldsForAccount(
		tenantId: string,
		accountId: string,
	): Promise<number> {
		const rows = await this.#read<{ total: number | bigint | string }>(
			tenantId,
			{
				text: SQL.countHoldsForAccount,
				parameters: [tenantId, accountId],
			},
		);
		return integer(rows[0]?.total ?? 0, 'row count');
	}

	async subjectKey(
		tenantId: string,
		subject: string,
		now: number,
	): Promise<SubjectKeyMaterial> {
		return this.handles.runtime.transaction(
			(transaction) => subjectKeyIn(transaction, tenantId, subject, now),
			{ access: 'write', tenantId },
		);
	}

	async getSubjectKey(
		tenantId: string,
		subject: string,
	): Promise<AuditSubjectKey | null> {
		const rows = await this.#read<SubjectKeyRow>(tenantId, {
			text: SQL.getSubjectKey,
			parameters: [tenantId, subject],
		});
		return rows[0] ? subjectKeyFromRow(rows[0]) : null;
	}

	async getSubjectKeyByMarker(
		tenantId: string,
		marker: string,
	): Promise<AuditSubjectKey | null> {
		const rows = await this.#read<SubjectKeyRow>(tenantId, {
			text: SQL.getSubjectKeyByMarker,
			parameters: [tenantId, marker],
		});
		return rows[0] ? subjectKeyFromRow(rows[0]) : null;
	}

	async destroySubjectKey(
		tenantId: string,
		subject: string,
		now: number,
	): Promise<AuditSubjectKey | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<SubjectKeyRow>({
					text: SQL.destroySubjectKey,
					parameters: [tenantId, subject, now],
				}),
			{ access: 'write', tenantId },
		);
		const row = result.rows[0];
		return row ? subjectKeyFromRow(row) : null;
	}

	async listSubjectKeys(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditSubjectKey[]> {
		const rows = await this.#read<SubjectKeyRow>(tenantId, {
			text: SQL.listSubjectKeys,
			parameters: [tenantId, limit],
		});
		return rows.map(subjectKeyFromRow);
	}

	async startErasureRun(input: StartErasureRunInput): Promise<AuditErasureRun> {
		const record: AuditErasureRun = {
			id: randomUUID(),
			tenantId: input.tenantId,
			subject: input.subject,
			subjectMarker: input.subjectMarker,
			status: 'requested',
			dryRun: input.dryRun,
			destroyKey: input.destroyKey,
			requestedBy: input.requestedBy,
			outputDirectory: input.outputDirectory,
			workspaceSlug: input.workspaceSlug,
			workspaceName: input.workspaceName,
			classes: 0,
			rows: 0,
			certificatePath: null,
			outcome: null,
			reason: null,
			startedAt: input.startedAt,
			completedAt: null,
		};
		await this.#write(input.tenantId, {
			text: SQL.insertErasureRun,
			parameters: [
				record.id,
				record.tenantId,
				record.subject,
				record.subjectMarker,
				record.dryRun ? 1 : 0,
				record.destroyKey ? 1 : 0,
				record.requestedBy,
				record.outputDirectory,
				record.workspaceSlug,
				record.workspaceName,
				record.startedAt,
			],
		});
		return record;
	}

	async finishErasureRun(
		input: FinishErasureRunInput,
	): Promise<AuditErasureRun | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<ErasureRunRow>({
					text: SQL.finishErasureRun,
					parameters: [
						input.tenantId,
						input.id,
						input.status,
						input.classes,
						input.rows,
						input.certificatePath,
						input.outcome === null ? null : JSON.stringify(input.outcome),
						input.reason,
						input.completedAt,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? erasureRunFromRow(row) : null;
	}

	async getErasureRun(
		tenantId: string,
		id: string,
	): Promise<AuditErasureRun | null> {
		const rows = await this.#read<ErasureRunRow>(tenantId, {
			text: SQL.getErasureRun,
			parameters: [tenantId, id],
		});
		return rows[0] ? erasureRunFromRow(rows[0]) : null;
	}

	async listPendingErasureRuns(
		limit: number,
	): Promise<readonly ErasureRunRouting[]> {
		const result = await this.handles.background.query<{
			tenant_id: string;
			id: string;
			started_at: number | bigint | string;
		}>({
			text: SQL.listPendingErasureRuns,
			parameters: [limit],
		});
		return result.rows.map((row) => ({
			tenantId: row.tenant_id,
			id: row.id,
			startedAt: integer(row.started_at, 'timestamp'),
		}));
	}

	async claimErasureRun(
		input: ClaimErasureRunInput,
	): Promise<AuditErasureRun | null> {
		const result = await this.handles.runtime.transaction(
			(transaction) =>
				transaction.query<ErasureRunRow>({
					text: SQL.claimErasureRun,
					parameters: [
						input.tenantId,
						input.id,
						input.claimedAt,
						input.staleBefore,
					],
				}),
			{ access: 'write', tenantId: input.tenantId },
		);
		const row = result.rows[0];
		return row ? erasureRunFromRow(row) : null;
	}

	async listErasureRuns(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditErasureRun[]> {
		const rows = await this.#read<ErasureRunRow>(tenantId, {
			text: SQL.listErasureRuns,
			parameters: [tenantId, limit],
		});
		return rows.map(erasureRunFromRow);
	}
}

/**
 * The subject's key inside a transaction that is already open. The insert
 * ignores a conflict and the read after it is what answers, so two events
 * written for one subject at the same moment share one key instead of one of
 * them failing.
 *
 * A subject whose key was destroyed is refused rather than given a new one: a
 * second key would seal the account into fresh events and undo the erasure the
 * first destruction performed. The caller writes such an event under the
 * subject's marker instead.
 */
async function subjectKeyIn(
	transaction: DatabaseTransaction,
	tenantId: string,
	subject: string,
	now: number,
): Promise<SubjectKeyMaterial> {
	const read = async () =>
		(
			await transaction.query<SubjectKeyRow>({
				text: SQL.getSubjectKey,
				parameters: [tenantId, subject],
			})
		).rows[0];
	const existing = await read();
	if (existing?.material) {
		return { id: existing.id, key: decodeSubjectKey(existing.material) };
	}
	const marker = erasureSubjectMarker(tenantId, subject);
	const tombstone = (
		await transaction.query<SubjectKeyRow>({
			text: SQL.getSubjectKeyByMarker,
			parameters: [tenantId, marker],
		})
	).rows[0];
	if (tombstone) {
		throw new AuditServiceError(
			'SUBJECT_KEY_DESTROYED',
			`The audit data key of this subject was destroyed on ${new Date(Number(tombstone.destroyed_at ?? 0)).toISOString()}; an event naming the subject again would create a new one and undo the erasure.`,
			409,
		);
	}
	const key = generateSubjectKey();
	const id = randomUUID();
	await transaction.execute({
		text: SQL.insertSubjectKey,
		parameters: [id, tenantId, subject, marker, encodeSubjectKey(key), now],
	});
	const stored = await read();
	if (!stored?.material) {
		throw new Error('The audit subject key could not be stored.');
	}
	return { id: stored.id, key: decodeSubjectKey(stored.material) };
}

export async function migrateAuditDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'audit.core', databaseMigrations);
}
