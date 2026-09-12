import type {
	AuditChainAnchor,
	AuditDataClass,
	AuditErasureRun,
	AuditEvent,
	AuditExportRun,
	AuditLegalHold,
	AuditSubjectKey,
	AuditSweepRun,
	AuditSubjectType,
	ExportRunSummary,
	ErasureClassOutcome,
	ErasureRunStatus,
	ExportStatus,
	HoldScopeKind,
	HoldStatus,
	RetentionMode,
	SweepStatus,
} from '../domain/types.ts';

/** What the registry says a class is, before a workspace ever read it. */
export interface DataClassFacts {
	readonly classId: string;
	readonly moduleId: string;
	readonly label: string;
	readonly exportable: boolean;
	readonly sweepable: boolean;
	readonly defaultRetentionDays: number | null;
}

/** Routing columns only, read across tenants on the background lease. */
export interface DataClassRouting {
	readonly tenantId: string;
	readonly classId: string;
	readonly lastSweptAt: number | null;
}

export interface AppendAuditEventInput {
	readonly tenantId: string;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: AuditSubjectType;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
	/**
	 * The person the event names. When present the actor, the subject and the
	 * details are sealed under that subject's data key, so destroying the key
	 * later makes them unreadable while the chain still verifies. Absent for an
	 * event written by the platform about itself.
	 */
	readonly subjectAccountId?: string | null;
}

/**
 * One event exactly as it is stored, sealed fields included. Verification and
 * sealing read this form: the hash of a row is a function of these bytes and of
 * nothing a key could unlock.
 */
export interface StoredAuditEvent {
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
	readonly eventHash: string;
	readonly subjectKeyId: string | null;
	readonly sealedPayload: string | null;
	/**
	 * The event format that wrote the row. Null means it was written before
	 * audit.core recorded one at all, which is the set verify reports as
	 * plaintext; a row carrying the marker and no sealed payload is an event
	 * about nobody rather than an unsealed person.
	 */
	readonly sealFormat: string | null;
}

export interface InsertAnchorInput {
	readonly tenantId: string;
	readonly anchorSequence: number;
	readonly fromSequence: number;
	readonly toSequence: number;
	readonly rowCount: number;
	readonly firstOccurredAt: number;
	readonly lastOccurredAt: number;
	readonly segmentHash: string;
	readonly previousAnchorHash: string | null;
	readonly anchorHash: string;
	readonly signature: string;
	readonly keyId: string;
	readonly segmentFile: string;
	readonly sealedBy: string;
	readonly sealedAt: number;
}

/** Routing columns only, read across tenants on the background lease. */
export interface AnchorRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly keyId: string;
}

export interface AnchorKeyCount {
	readonly keyId: string;
	readonly anchors: number;
}

export interface InsertHoldInput {
	readonly tenantId: string;
	readonly scopeKind: HoldScopeKind;
	readonly accountId: string | null;
	readonly classId: string | null;
	readonly fromAt: number | null;
	readonly toAt: number | null;
	readonly reason: string;
	readonly placedBy: string;
	readonly placedAt: number;
}

export interface LiftHoldRecordInput {
	readonly tenantId: string;
	readonly id: string;
	readonly liftedBy: string;
	readonly liftReason: string;
	readonly liftedAt: number;
}

export interface SubjectKeyMaterial {
	readonly id: string;
	readonly key: Buffer;
}

export interface StartErasureRunInput {
	readonly tenantId: string;
	readonly subject: string;
	readonly subjectMarker: string;
	readonly requestedBy: string;
	/** Absolute and inside the directory the deployment allows; null for a plan. */
	readonly outputDirectory: string | null;
	readonly dryRun: boolean;
	readonly destroyKey: boolean;
	readonly workspaceSlug: string | null;
	readonly workspaceName: string | null;
	readonly startedAt: number;
}

export interface FinishErasureRunInput {
	readonly tenantId: string;
	readonly id: string;
	readonly status: Exclude<ErasureRunStatus, 'requested'>;
	readonly classes: number;
	readonly rows: number;
	readonly certificatePath: string | null;
	readonly outcome: readonly ErasureClassOutcome[] | null;
	readonly reason: string | null;
	readonly completedAt: number;
}

/** Routing columns only, read across tenants on the background lease. */
export interface ErasureRunRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly startedAt: number;
}

export interface ClaimErasureRunInput {
	readonly tenantId: string;
	readonly id: string;
	readonly claimedAt: number;
	/** A claim older than this is taken over; the process holding it is gone. */
	readonly staleBefore: number;
}

export interface AppendSweepRunInput {
	readonly tenantId: string;
	readonly classId: string;
	readonly cutoff: number;
	readonly removed: number;
	readonly status: SweepStatus;
	readonly reason: string | null;
	/** Rows a hold withheld, or null when only the owning module could count them. */
	readonly heldBack: number | null;
	readonly occurredAt: number;
}

export interface StartExportRunInput {
	readonly tenantId: string;
	readonly formatVersion: string;
	readonly requestedBy: string;
	/** Absolute, inside the directory the deployment allows. */
	readonly outputDirectory: string;
	readonly dryRun: boolean;
	readonly workspaceSlug: string | null;
	readonly workspaceName: string | null;
	readonly startedAt: number;
}

export interface FinishExportRunInput {
	readonly tenantId: string;
	readonly id: string;
	readonly status: Exclude<ExportStatus, 'started'>;
	readonly classes: number;
	readonly rows: number;
	readonly archiveDigest: string | null;
	readonly archivePath: string | null;
	readonly reason: string | null;
	readonly summary: ExportRunSummary | null;
	readonly completedAt: number;
}

export interface ClaimExportRunInput {
	readonly tenantId: string;
	readonly id: string;
	readonly claimedAt: number;
	/** A claim older than this is taken over; the process holding it is gone. */
	readonly staleBefore: number;
}

/** Routing columns only, read across tenants on the background lease. */
export interface ExportRunRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly startedAt: number;
}

/**
 * The persistence port. Async and database agnostic: the PostgreSQL
 * statements, the tenant transactions and the cross-tenant routing lease live
 * in the adapter.
 */
export interface AuditRepository {
	/**
	 * Writes the classes the registry declared into one workspace and refreshes
	 * the facts of the ones already there. The workspace's period and sweep
	 * stamp are never touched. Answers every stored class of the workspace.
	 */
	materializeDataClasses(
		tenantId: string,
		facts: readonly DataClassFacts[],
		now: number,
	): Promise<readonly AuditDataClass[]>;
	listDataClasses(tenantId: string): Promise<readonly AuditDataClass[]>;
	getDataClass(
		tenantId: string,
		classId: string,
	): Promise<AuditDataClass | null>;
	/** Null when the workspace holds no row for the class. */
	setRetention(
		tenantId: string,
		classId: string,
		mode: RetentionMode,
		days: number | null,
		now: number,
	): Promise<AuditDataClass | null>;
	stampSwept(
		tenantId: string,
		classId: string,
		sweptAt: number,
	): Promise<boolean>;

	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listDueDataClasses(
		staleBefore: number,
		limit: number,
	): Promise<readonly DataClassRouting[]>;

	appendSweepRun(input: AppendSweepRunInput): Promise<AuditSweepRun>;
	listSweepRuns(
		tenantId: string,
		status: SweepStatus | undefined,
		limit: number,
	): Promise<readonly AuditSweepRun[]>;
	/** Newest run of one class, so a standing refusal is not repeated. */
	latestSweepRun(
		tenantId: string,
		classId: string,
	): Promise<AuditSweepRun | null>;

	startExportRun(input: StartExportRunInput): Promise<AuditExportRun>;
	finishExportRun(input: FinishExportRunInput): Promise<AuditExportRun | null>;
	getExportRun(tenantId: string, id: string): Promise<AuditExportRun | null>;
	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listPendingExportRuns(limit: number): Promise<readonly ExportRunRouting[]>;
	/**
	 * Takes the run for this process, or answers null when it is no longer
	 * requested or another process holds an unexpired claim. The read and the
	 * claim are one statement, so two platform processes cannot both perform
	 * one export.
	 */
	claimExportRun(input: ClaimExportRunInput): Promise<AuditExportRun | null>;
	listExportRuns(
		tenantId: string,
		status: ExportStatus | undefined,
		limit: number,
	): Promise<readonly AuditExportRun[]>;

	/**
	 * Keyset pages for the export, ordered by id so a full walk sees every row
	 * exactly once however long it runs. `afterId` is the last id of the page
	 * before it; the empty string starts the walk.
	 */
	exportAuditEventsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditEvent[]>;
	exportSweepRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditSweepRun[]>;
	exportExportRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditExportRun[]>;
	exportLegalHoldsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditLegalHold[]>;
	exportErasureRunsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AuditErasureRun[]>;

	/** Appends one link of the workspace chain inside a single transaction. */
	appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEvent>;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditEvent[]>;

	/**
	 * Events after `afterSequence` in sequence order, exactly as stored. The
	 * sealing pass walks this twice, once to compute the segment chain and once
	 * to write the file, and both walks see the same rows because the range it
	 * seals is closed before the second one starts.
	 */
	sealAuditEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly StoredAuditEvent[]>;
	/** Events older than `cutoff`; `maxSequence` null counts the unsealed ones too. */
	countAuditEventsBefore(
		tenantId: string,
		cutoff: number,
		maxSequence: number | null,
	): Promise<number>;
	/** Removes at most `limit` events older than `cutoff` at or below `maxSequence`. */
	deleteAuditEventsBefore(
		tenantId: string,
		cutoff: number,
		maxSequence: number,
		limit: number,
	): Promise<number>;
	/**
	 * Ages the two ledgers audit.core keeps about itself. A run still waiting for
	 * the platform is never removed: the command that recorded it is still
	 * polling the row.
	 */
	deleteSweepRunsBefore(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;
	deleteExportRunsBefore(
		tenantId: string,
		cutoff: number,
		limit: number,
	): Promise<number>;

	latestAnchor(tenantId: string): Promise<AuditChainAnchor | null>;
	listAnchors(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditChainAnchor[]>;
	insertAnchor(input: InsertAnchorInput): Promise<AuditChainAnchor>;
	/**
	 * Writes a new signature over the same anchor hash. The stored signature is
	 * the optimistic check, so an anchor re-signed by another process in between
	 * keeps its own row and is counted as skipped rather than overwritten.
	 */
	resignAnchor(input: {
		readonly tenantId: string;
		readonly id: string;
		readonly signature: string;
		readonly keyId: string;
		readonly expectedSignature: string;
	}): Promise<boolean>;
	/** Cross-tenant, routing columns only, on the read-only background lease. */
	countAnchorsByKey(): Promise<readonly AnchorKeyCount[]>;
	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listAnchorsNotOnKey(
		keyId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AnchorRouting[]>;
	getAnchor(tenantId: string, id: string): Promise<AuditChainAnchor | null>;

	insertHold(input: InsertHoldInput): Promise<AuditLegalHold>;
	liftHold(input: LiftHoldRecordInput): Promise<AuditLegalHold | null>;
	getHold(tenantId: string, id: string): Promise<AuditLegalHold | null>;
	listHolds(
		tenantId: string,
		status: HoldStatus | undefined,
		limit: number,
	): Promise<readonly AuditLegalHold[]>;
	/** Every hold still standing, bounded; the sweep and erasure read this. */
	listActiveHolds(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditLegalHold[]>;
	/**
	 * Holds naming one account, lifted ones included. An erasure plan counts
	 * them so the certificate says what evidence about the subject stays.
	 */
	countHoldsForAccount(tenantId: string, accountId: string): Promise<number>;

	/**
	 * The subject's data key, created on first use. A destroyed key is never
	 * recreated under the same subject: the row that held it keeps its id and
	 * the events that point at it stay unreadable for ever.
	 */
	subjectKey(
		tenantId: string,
		subject: string,
		now: number,
	): Promise<SubjectKeyMaterial>;
	/** Null when the subject never had one; the destroyed row answers its state. */
	getSubjectKey(
		tenantId: string,
		subject: string,
	): Promise<AuditSubjectKey | null>;
	/**
	 * The key row by the marker it keeps for ever, which is the only way to find
	 * a destroyed one: destruction removes the account the key belonged to.
	 */
	getSubjectKeyByMarker(
		tenantId: string,
		marker: string,
	): Promise<AuditSubjectKey | null>;
	destroySubjectKey(
		tenantId: string,
		subject: string,
		now: number,
	): Promise<AuditSubjectKey | null>;
	listSubjectKeys(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditSubjectKey[]>;

	startErasureRun(input: StartErasureRunInput): Promise<AuditErasureRun>;
	/** Blanks the subject in the same statement: a finished run names nobody. */
	finishErasureRun(
		input: FinishErasureRunInput,
	): Promise<AuditErasureRun | null>;
	getErasureRun(tenantId: string, id: string): Promise<AuditErasureRun | null>;
	/** Cross-tenant, routing columns only, on the read-only background lease. */
	listPendingErasureRuns(limit: number): Promise<readonly ErasureRunRouting[]>;
	/**
	 * Takes the run for this process, or answers null when it is no longer
	 * requested or another process holds an unexpired claim.
	 */
	claimErasureRun(input: ClaimErasureRunInput): Promise<AuditErasureRun | null>;
	listErasureRuns(
		tenantId: string,
		limit: number,
	): Promise<readonly AuditErasureRun[]>;
}
