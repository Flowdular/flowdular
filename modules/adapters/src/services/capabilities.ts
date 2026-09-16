/*
 * The public contracts adapters.core consumes, declared here rather than
 * imported, so each stays an optional capability and never a package
 * dependency. Each mirrors the owner's own declaration and must not drift:
 * connectors.calls.v1 (modules/connectors/src/domain/calls.ts),
 * import.write.v1 (modules/import/src/domain/write.ts),
 * exports.lists.v1 (modules/exports/src/domain/lists.ts) and
 * metering.meters.v1 (modules/metering/src/domain/meters.ts).
 */
import type { AuthPrincipal } from '@flowdular/module-auth';
import type { DefinedListExport } from '@flowdular/server';

export const CONNECTORS_CALLS_CAPABILITY = 'connectors.calls.v1';
export const IMPORT_WRITE_CAPABILITY = 'import.write.v1';
export const EXPORT_LISTS_CAPABILITY = 'exports.lists.v1';
export const METERING_METERS_CAPABILITY = 'metering.meters.v1';

export type ConnectorCaller = 'test' | 'workflow' | 'agent';

export interface ConnectorCallAnswer {
	readonly callId: string;
	readonly outcome: 'succeeded' | 'failed' | 'refused';
	readonly status: number | null;
	readonly errorClass: string | null;
	readonly body: unknown;
	readonly replayed: boolean;
	readonly retryAfterMs: number | null;
}

export interface ConnectorCalls {
	call(request: {
		readonly tenantId: string;
		readonly instanceId: string;
		readonly operation: string;
		readonly input: Readonly<Record<string, unknown>>;
		readonly caller: ConnectorCaller;
		readonly callerRef?: string | undefined;
		readonly idempotencyKey?: string | undefined;
		readonly signal?: AbortSignal | undefined;
	}): Promise<ConnectorCallAnswer>;
	consented(
		tenantId: string,
		instanceId: string,
		caller: ConnectorCaller,
	): Promise<boolean>;
}

export interface ImportTargetField {
	readonly id: string;
	readonly label: string;
	readonly required: boolean;
	readonly type: string;
}

export interface ImportWriteTarget {
	readonly target: string;
	readonly moduleId: string;
	readonly key: string;
	readonly label: string;
	readonly permission: string;
	readonly fields: readonly ImportTargetField[];
	readonly naturalKey: readonly string[];
	readonly batchSize: number;
}

export interface ImportWriteRow {
	readonly row: number;
	readonly values: Readonly<Record<string, string>>;
}

export interface ImportWriter {
	describe(moduleId: string, portKey: string): ImportWriteTarget | null;
	validate(input: {
		readonly tenantId: string;
		readonly principal: AuthPrincipal;
		readonly moduleId: string;
		readonly portKey: string;
		readonly rows: readonly ImportWriteRow[];
	}): Promise<
		readonly {
			readonly row: number;
			readonly verdict: 'valid' | 'invalid';
			readonly field?: string;
			readonly reason?: string;
		}[]
	>;
	write(input: {
		readonly tenantId: string;
		readonly principal: AuthPrincipal;
		readonly moduleId: string;
		readonly portKey: string;
		readonly rows: readonly ImportWriteRow[];
		readonly mode: 'create-only' | 'update-existing' | 'skip-existing';
		readonly sourceRef: string;
	}): Promise<
		readonly {
			readonly row: number;
			readonly outcome:
				| 'created'
				| 'updated'
				| 'skipped'
				| 'invalid'
				| 'failed';
			readonly field?: string;
			readonly reason?: string;
			readonly recordRef?: string;
		}[]
	>;
}

export interface ExportLists {
	register(moduleId: string, exports: readonly DefinedListExport[]): void;
	find(id: string): DefinedListExport | null;
}

export interface MeterRegistry {
	declare(
		moduleId: string,
		meters: readonly {
			readonly key: string;
			readonly label: string;
			readonly unit: string;
			readonly kind: 'cumulative' | 'gauge';
		}[],
	): void;
	record(input: {
		readonly tenantId: string;
		readonly meter: string;
		readonly amount: number;
		readonly at?: number;
		readonly sourceRef?: string;
	}): Promise<unknown>;
}
