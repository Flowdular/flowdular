/*
 * The public contracts research.core consumes, declared here rather than
 * imported, so each stays an optional capability and never a package
 * dependency. Each mirrors the owner's own declaration and must not drift:
 * connectors.calls.v1 and connectors.egress.v1 (modules/connectors/src/domain),
 * metering.meters.v1 (modules/metering/src/domain/meters.ts) and
 * exports.lists.v1 (modules/exports/src/domain/lists.ts).
 */
import type { DefinedListExport } from '@flowdular/server';

export const CONNECTORS_CALLS_CAPABILITY = 'connectors.calls.v1';
export const CONNECTORS_EGRESS_CAPABILITY = 'connectors.egress.v1';
export const METERING_METERS_CAPABILITY = 'metering.meters.v1';
export const EXPORT_LISTS_CAPABILITY = 'exports.lists.v1';

export interface ConnectorCalls {
	call(request: {
		readonly tenantId: string;
		readonly instanceId: string;
		readonly operation: string;
		readonly input: Readonly<Record<string, unknown>>;
		readonly caller: 'test' | 'workflow' | 'agent';
		readonly callerRef?: string | undefined;
		readonly signal?: AbortSignal | undefined;
	}): Promise<{
		readonly callId: string;
		readonly outcome: 'succeeded' | 'failed' | 'refused';
		readonly status: number | null;
		readonly errorClass: string | null;
		readonly body: unknown;
	}>;
}

export type EgressLookup = (
	hostname: string,
	options: { readonly all?: boolean | undefined },
	callback: (
		error: Error | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void,
) => void;

export type EgressCheck =
	| {
			readonly ok: true;
			readonly url: string;
			readonly addresses: readonly string[];
			readonly lookup: EgressLookup;
	  }
	| { readonly ok: false; readonly reason: string };

export interface ConnectorEgress {
	check(url: string): Promise<EgressCheck>;
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
	}): Promise<{ readonly recorded: boolean; readonly day: string }>;
	check(input: {
		readonly tenantId: string;
		readonly meter: string;
		readonly amount: number;
	}): Promise<{
		readonly verdict: 'allowed' | 'warning' | 'refused';
		readonly used: number;
		readonly limit: number | null;
	}>;
}

export interface ExportListRegistry {
	register(moduleId: string, exports: readonly DefinedListExport[]): void;
}
