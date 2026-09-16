/*
 * The public contracts research.core consumes, declared here rather than
 * imported, so each stays an optional capability and never a package
 * dependency. Each mirrors the owner's own declaration and must not drift:
 * connectors.calls.v1, connectors.definitions.v1, connectors.instances.v1 and
 * connectors.egress.v1 (modules/connectors/src/domain),
 * metering.meters.v1 (modules/metering/src/domain/meters.ts),
 * exports.lists.v1 (modules/exports/src/domain/lists.ts) and
 * documents.text.v1 (modules/documents/src/domain/text.ts).
 */
import type { DefinedListExport } from '@flowdular/server';

export const CONNECTORS_CALLS_CAPABILITY = 'connectors.calls.v1';
export const CONNECTORS_DEFINITIONS_CAPABILITY = 'connectors.definitions.v1';
export const CONNECTORS_INSTANCES_CAPABILITY = 'connectors.instances.v1';
export const CONNECTORS_EGRESS_CAPABILITY = 'connectors.egress.v1';
export const METERING_METERS_CAPABILITY = 'metering.meters.v1';
export const EXPORT_LISTS_CAPABILITY = 'exports.lists.v1';
export const DOCUMENTS_TEXT_CAPABILITY = 'documents.text.v1';

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
		readonly retryAfterMs?: number | null;
	}>;
}

export type ConnectorAuthKind =
	| 'none'
	| 'api-key'
	| 'bearer'
	| 'oauth2-client-credentials';

export interface ConnectorDefinitionShape {
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly authKinds: readonly ConnectorAuthKind[];
	readonly operations: readonly {
		readonly key: string;
		readonly label: string;
		readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
		readonly path: string;
		readonly inputSchema: Readonly<Record<string, unknown>>;
		readonly outputSchema: Readonly<Record<string, unknown>>;
	}[];
	readonly defaultAllowedHosts: readonly string[];
	readonly allowedPorts?: readonly number[] | undefined;
}

export interface ConnectorDefinitions {
	register(definition: ConnectorDefinitionShape): void;
	get(key: string): ConnectorDefinitionShape | null;
}

export type ConnectorModuleCredentials = {
	readonly kind: ConnectorAuthKind;
} & Readonly<Record<string, unknown>>;

export interface ConnectorModuleInstance {
	readonly id: string;
	readonly moduleId: string;
	readonly key: string;
	readonly definition: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly authKind: ConnectorAuthKind;
	readonly hasCredentials: boolean;
	readonly allowedHosts: readonly string[];
	readonly allowAgents: boolean;
	readonly allowWorkflows: boolean;
	readonly status: 'active' | 'disabled';
	readonly updatedAt: number;
}

export interface ConnectorInstances {
	upsertModuleInstance(input: {
		readonly tenantId: string;
		readonly moduleId: string;
		readonly key: string;
		readonly definition: string;
		readonly baseUrl: string;
		readonly credentials?: ConnectorModuleCredentials | undefined;
		readonly allowedHosts: readonly string[];
		readonly allowAgents: boolean;
		readonly allowWorkflows: boolean;
		readonly actor: string;
	}): Promise<ConnectorModuleInstance>;
	describeModuleInstance(input: {
		readonly tenantId: string;
		readonly moduleId: string;
		readonly key: string;
	}): Promise<ConnectorModuleInstance | null>;
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

/** The part of documents.text.v1 a fetch uses: text out of bytes it holds. */
export interface DocumentsText {
	extractBytes(input: {
		readonly contentType: string;
		readonly bytes: Uint8Array;
		readonly signal?: AbortSignal | undefined;
	}): Promise<{
		readonly status:
			| 'ok'
			| 'unscanned'
			| 'unsupported'
			| 'too-large'
			| 'pending';
		readonly reason: string | null;
		readonly text: string;
	}>;
}
