import type {
	AdapterDirection,
	AdapterJson,
	AdapterMappingRule,
} from './registry.ts';

export const ADAPTERS_MODULE_ID = 'adapters.core';

export const ADAPTER_RUN_STATUSES = [
	'queued',
	'running',
	'succeeded',
	'failed',
	'cancelled',
] as const;
export type AdapterRunStatus = (typeof ADAPTER_RUN_STATUSES)[number];

export const ADAPTER_RUN_TRIGGERS = ['manual', 'schedule', 'resume'] as const;
export type AdapterRunTrigger = (typeof ADAPTER_RUN_TRIGGERS)[number];

export const ADAPTER_ROW_OUTCOMES = [
	'created',
	'updated',
	'skipped',
	'invalid',
	'failed',
	'pushed',
] as const;
export type AdapterRowOutcome = (typeof ADAPTER_ROW_OUTCOMES)[number];

export const ADAPTER_AUDIT_ACTIONS = [
	'binding-saved',
	'binding-enabled',
	'binding-disabled',
	'run-started',
	'run-resumed',
	'run-cancelled',
	'schedule-skipped',
] as const;
export type AdapterAuditAction = (typeof ADAPTER_AUDIT_ACTIONS)[number];

export const ADAPTER_LIMITS = {
	id: 96,
	moduleId: 64,
	label: 120,
	adaptersPerModule: 32,
	adapters: 256,
	runId: 64,
	instanceId: 128,
	accountId: 128,
	mappingRules: 64,
	path: 200,
	pathSegments: 8,
	value: 2000,
	lookupEntries: 500,
	lookupText: 200,
	mappingJson: 32_768,
	inputJson: 8_192,
	recordedCalls: 256,
	recordedJson: 1_048_576,
	cursor: 2048,
	schedule: 100,
	pagesPerRun: 1000,
	recordsPerPage: 1000,
	attemptsPerPage: 3,
	/** Idempotency key slots one push may take, spent ones included. */
	keySlots: 32,
	sinkBatch: 50,
	sinkBatchMax: 200,
	dryRunRows: 20,
	errorCode: 64,
	message: 200,
	naturalKey: 200,
	auditMetadata: 2048,
	/** Rows one API page may carry; the platform page ceiling. */
	page: 200,
	/** Runs or due bindings one routing read considers. */
	routingPage: 25,
	retryBaseMs: 500,
	retryCapMs: 5000,
} as const;

export interface AdapterBinding {
	readonly tenantId: string;
	readonly adapterId: string;
	readonly instanceId: string | null;
	readonly enabled: boolean;
	/** Null uses the registered mapping. */
	readonly mapping: readonly AdapterMappingRule[] | null;
	/** Null uses the registered schedule, empty is on demand only. */
	readonly schedule: string | null;
	readonly nextRunAt: number | null;
	readonly updatedBy: string | null;
	readonly updatedAt: number;
}

export interface AdapterRun {
	readonly id: string;
	readonly tenantId: string;
	readonly adapterId: string;
	readonly direction: AdapterDirection;
	readonly status: AdapterRunStatus;
	readonly trigger: AdapterRunTrigger;
	/** The run a resume continues; its idempotency keys stay the first run's. */
	readonly resumedFrom: string | null;
	readonly cursor: string | null;
	readonly pages: number;
	readonly rowsRead: number;
	readonly rowsCreated: number;
	readonly rowsUpdated: number;
	readonly rowsSkipped: number;
	readonly rowsFailed: number;
	readonly errorCode: string | null;
	readonly claimedBy: string | null;
	readonly leaseUntil: number | null;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly finishedAt: number | null;
	readonly startedBy: string | null;
}

/** A run as the API answers it: the claim is the runner's own. */
export type AdapterRunView = Omit<AdapterRun, 'claimedBy' | 'leaseUntil'>;

export function adapterRunView(run: AdapterRun): AdapterRunView {
	return {
		id: run.id,
		tenantId: run.tenantId,
		adapterId: run.adapterId,
		direction: run.direction,
		status: run.status,
		trigger: run.trigger,
		resumedFrom: run.resumedFrom,
		cursor: run.cursor,
		pages: run.pages,
		rowsRead: run.rowsRead,
		rowsCreated: run.rowsCreated,
		rowsUpdated: run.rowsUpdated,
		rowsSkipped: run.rowsSkipped,
		rowsFailed: run.rowsFailed,
		errorCode: run.errorCode,
		queuedAt: run.queuedAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		startedBy: run.startedBy,
	};
}

export interface AdapterRunRow {
	readonly tenantId: string;
	readonly runId: string;
	readonly rowIndex: number;
	readonly naturalKey: string | null;
	readonly outcome: AdapterRowOutcome;
	readonly errorCode: string | null;
	readonly message: string | null;
}

export interface AdapterAuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly adapterId: string;
	readonly runId: string | null;
	readonly action: AdapterAuditAction;
	readonly actorId: string | null;
	readonly metadata: Readonly<Record<string, AdapterJson>>;
	readonly occurredAt: number;
}

/** What the cross-tenant run routing read may see, and nothing else. */
export interface AdapterRunRouting {
	readonly tenantId: string;
	readonly id: string;
}

/** What the cross-tenant schedule routing read may see, and nothing else. */
export interface AdapterDueBinding {
	readonly tenantId: string;
	readonly adapterId: string;
	readonly nextRunAt: number;
}
