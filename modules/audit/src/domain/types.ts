/** How a workspace decided the period of one class. */
export const RETENTION_MODES = ['default', 'days', 'none'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export const SWEEP_STATUSES = ['completed', 'partial', 'refused'] as const;
export type SweepStatus = (typeof SWEEP_STATUSES)[number];

export const EXPORT_STATUSES = ['started', 'completed', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Stable reasons the ledger records; the screens translate them by code. */
export const AUDIT_REASONS = {
	backupManifestMissing: 'BACKUP_MANIFEST_MISSING',
	legalHold: 'LEGAL_HOLD',
	ownerSweepFailed: 'OWNER_SWEEP_FAILED',
	batchCapReached: 'BATCH_CAP_REACHED',
	holdActive: 'HOLD_ACTIVE',
	segmentNotSealed: 'SEGMENT_NOT_SEALED',
	erasureRequestExpired: 'ERASURE_REQUEST_EXPIRED',
} as const;

/** What a hold was placed on; the narrowing columns may restrict it further. */
export const HOLD_SCOPE_KINDS = [
	'account',
	'workspace',
	'data-class',
	'date-range',
] as const;
export type HoldScopeKind = (typeof HOLD_SCOPE_KINDS)[number];

export const HOLD_STATUSES = ['active', 'lifted'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const SUBJECT_KEY_STATES = ['active', 'destroyed'] as const;
export type SubjectKeyState = (typeof SUBJECT_KEY_STATES)[number];

export const ERASURE_RUN_STATUSES = [
	'requested',
	'completed',
	'partial',
	'failed',
] as const;
export type ErasureRunStatus = (typeof ERASURE_RUN_STATUSES)[number];

/**
 * What happened to one class, or what would happen to it in a plan. Every class
 * the sealed registry carries gets one, so a plan and a certificate name the
 * whole catalogue rather than only the classes that can be erased.
 */
export const ERASURE_CLASS_OUTCOMES = [
	/** Declares an erase operation; a plan says how many rows it would remove. */
	'erasable',
	'erased',
	/** Declares no erase operation, so the subject stays in it. */
	'not-erasable',
	/** The owner answered with an error; `failure` carries its words. */
	'failed',
] as const;
export type ErasureClassOutcomeKind = (typeof ERASURE_CLASS_OUTCOMES)[number];

/** One class of an erasure plan or result. Null rows means nobody counted. */
export interface ErasureClassOutcome {
	readonly moduleId: string;
	readonly classId: string;
	readonly outcome: ErasureClassOutcomeKind;
	readonly rows: number | null;
	/** True when the class still holds rows of the subject after the batch cap. */
	readonly truncated?: boolean;
	/** The owner's own words when it answered with an error instead. */
	readonly failure?: string;
}

/**
 * One erasure as the workspace records it. The operator command writes the
 * request columns and the running platform, the only process holding every
 * module's erase operation, writes the result ones.
 */
export interface AuditErasureRun {
	readonly id: string;
	readonly tenantId: string;
	/** Kept while the run needs it and blanked when it finishes. */
	readonly subject: string | null;
	/** The hash the certificate file is named after; it names nobody. */
	readonly subjectMarker: string;
	readonly status: ErasureRunStatus;
	/** A plan: the platform counts through every registration and removes nothing. */
	readonly dryRun: boolean;
	readonly destroyKey: boolean;
	readonly requestedBy: string;
	/** Deployment paths, never part of the workspace's own data. */
	readonly outputDirectory: string | null;
	readonly workspaceSlug: string | null;
	readonly workspaceName: string | null;
	readonly classes: number;
	readonly rows: number;
	readonly certificatePath: string | null;
	readonly outcome: readonly ErasureClassOutcome[] | null;
	readonly reason: string | null;
	readonly startedAt: number;
	readonly completedAt: number | null;
}

/** One class a module declared, as one workspace sees it. */
export interface AuditDataClass {
	readonly id: string;
	readonly tenantId: string;
	/** `${moduleId}.${key}`, for example `agents.core.runs`. */
	readonly classId: string;
	readonly moduleId: string;
	readonly label: string;
	readonly exportable: boolean;
	readonly sweepable: boolean;
	readonly defaultRetentionDays: number | null;
	readonly retentionMode: RetentionMode;
	/** The workspace's own period; null unless `retentionMode` is `days`. */
	readonly retentionDays: number | null;
	/** What the sweep uses. Null means kept until a person deletes. */
	readonly effectiveRetentionDays: number | null;
	readonly lastSweptAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** One retention pass over one class of one workspace. */
export interface AuditSweepRun {
	readonly id: string;
	readonly tenantId: string;
	readonly classId: string;
	readonly cutoff: number;
	readonly removed: number;
	readonly status: SweepStatus;
	readonly reason: string | null;
	/**
	 * Rows an active hold withheld, where audit.core owns the class and can
	 * count them. Null when only the owning module could: the kernel sweep
	 * input carries no row predicate, so a held foreign class is withheld whole
	 * and its row count stays inside the module that owns it.
	 */
	readonly heldBack: number | null;
	readonly occurredAt: number;
}

export interface ExportRunClassSummary {
	readonly classId: string;
	readonly rows: number;
	readonly from: string | null;
	readonly to: string | null;
}

export interface ExportRunExclusion {
	readonly classId: string;
	readonly reason: string;
}

/**
 * What the run carried, as the platform recorded it, so the operator command
 * and the screens read the outcome without opening the archive. Bounded by
 * `EXPORT_SUMMARY_ENTRIES`: `truncated` says when a deployment declared more
 * classes than one row may name.
 */
export interface ExportRunSummary {
	readonly complete: boolean;
	readonly classes: readonly ExportRunClassSummary[];
	readonly exclusions: readonly ExportRunExclusion[];
	readonly truncated: boolean;
}

/**
 * One per-workspace export as recorded in the workspace. The operator command
 * writes the request columns and the running platform writes the result ones,
 * so a run is a request until the platform answers it.
 */
export interface AuditExportRun {
	readonly id: string;
	readonly tenantId: string;
	readonly formatVersion: string;
	readonly status: ExportStatus;
	/** A plan: the platform counts through every owner port and writes nothing. */
	readonly dryRun: boolean;
	readonly classes: number;
	readonly rows: number;
	readonly archiveDigest: string | null;
	readonly requestedBy: string;
	/** A stable reason when the run failed or was refused. */
	readonly reason: string | null;
	/** Deployment paths, never part of the workspace's own exported data. */
	readonly outputDirectory: string | null;
	readonly archivePath: string | null;
	readonly workspaceSlug: string | null;
	readonly workspaceName: string | null;
	readonly summary: ExportRunSummary | null;
	readonly startedAt: number;
	readonly completedAt: number | null;
}

export const AUDIT_SUBJECT_TYPES = [
	'data-class',
	'sweep-run',
	'export-run',
	'legal-hold',
	'erasure',
	'chain-anchor',
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

/** The actions audit.core writes into its own hash-chained trail. */
export const AUDIT_EVENT_ACTIONS = {
	retentionSet: 'audit.retention.set',
	retentionSweep: 'audit.retention.sweep',
	retentionRefused: 'audit.retention.refused',
	exportStarted: 'audit.export.started',
	exportCompleted: 'audit.export.completed',
	exportFailed: 'audit.export.failed',
	chainSealed: 'audit.chain.sealed',
	holdPlaced: 'audit.hold.placed',
	holdLifted: 'audit.hold.lifted',
	erasureStarted: 'audit.erasure.started',
	erasureCompleted: 'audit.erasure.completed',
	subjectKeyDestroyed: 'audit.erasure.key-destroyed',
} as const;

/**
 * What a sealed event stores where the actor and the subject used to sit. It is
 * part of the hash preimage of every sealed row, so it can never change.
 */
export const AUDIT_SEALED_MARKER = 'sealed:v1';

/**
 * One link of the per-workspace chain. `previousHash` is the `eventHash` of the
 * event before it, so a removed or edited row breaks every hash after it.
 */
export interface AuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly sequence: number;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: AuditSubjectType;
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
	/** True when the actor, the subject and the details travel sealed. */
	readonly sealed: boolean;
	/**
	 * The subject key row that sealed this event. The account it belonged to is
	 * not stored here: destroying the key is what makes the event anonymous.
	 */
	readonly subjectKeyId: string | null;
	/** False when the row is sealed and its key has been destroyed. */
	readonly readable: boolean;
}

/** One sealed segment of a workspace's chain, as the anchor records it. */
export interface AuditChainAnchor {
	readonly id: string;
	readonly tenantId: string;
	readonly anchorSequence: number;
	readonly fromSequence: number;
	readonly toSequence: number;
	readonly rowCount: number;
	readonly firstOccurredAt: number;
	readonly lastOccurredAt: number;
	/** The chain over the segment, continuing from `previousAnchorHash`. */
	readonly segmentHash: string;
	readonly previousAnchorHash: string | null;
	readonly anchorHash: string;
	/** HMAC-SHA256 of `anchorHash`; a rotation rewrites this and `keyId` only. */
	readonly signature: string;
	readonly keyId: string;
	readonly segmentFile: string;
	readonly sealedBy: string;
	readonly sealedAt: number;
}

/** One standing instruction not to remove the data it covers. */
export interface AuditLegalHold {
	readonly id: string;
	readonly tenantId: string;
	readonly scopeKind: HoldScopeKind;
	readonly accountId: string | null;
	readonly classId: string | null;
	readonly fromAt: number | null;
	readonly toAt: number | null;
	readonly reason: string;
	readonly status: HoldStatus;
	readonly placedBy: string;
	readonly placedAt: number;
	readonly liftedBy: string | null;
	readonly liftReason: string | null;
	readonly liftedAt: number | null;
}

export interface PlaceHoldInput {
	readonly scopeKind: HoldScopeKind;
	readonly accountId?: string | null;
	readonly classId?: string | null;
	readonly fromAt?: number | null;
	readonly toAt?: number | null;
	readonly reason: string;
}

export interface LiftHoldInput {
	readonly id: string;
	readonly reason: string;
}

/** The data key one subject's audit metadata is sealed under. */
export interface AuditSubjectKey {
	readonly id: string;
	readonly tenantId: string;
	/** Cleared with the material when the key is destroyed. */
	readonly subject: string | null;
	/**
	 * The name the subject keeps once its key is gone. It outlives destruction,
	 * so a destroyed key is still findable and the subject it belonged to is
	 * never given a new one.
	 */
	readonly subjectMarker: string | null;
	readonly state: SubjectKeyState;
	readonly sealedAt: number;
	readonly destroyedAt: number | null;
}

/** The registry as one workspace sees it, including modules holding nothing. */
export interface AuditRegistryModule {
	readonly moduleId: string;
	readonly classes: readonly AuditDataClass[];
}

export interface SetRetentionInput {
	readonly classId: string;
	readonly mode: RetentionMode;
	/** Required when `mode` is `days`; 1 to 36500. */
	readonly days?: number | null;
}
