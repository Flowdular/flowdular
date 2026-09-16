import type { ConnectorAuthKind } from './types.ts';

/**
 * The capability a module resolves to keep one instance of its own connector
 * definition per workspace, configured from the module's own settings screen
 * instead of the Connectors screen. The instance stays an ordinary instance:
 * the call path, the consent gate, the call log and the owner's controls apply
 * to it unchanged.
 */
export const CONNECTORS_INSTANCES_CAPABILITY = 'connectors.instances.v1';

/** The fields the create route accepts for the kind, sealed on arrival. */
export type ConnectorModuleCredentials = {
	readonly kind: ConnectorAuthKind;
} & Readonly<Record<string, unknown>>;

export interface ConnectorModuleInstanceInput {
	readonly tenantId: string;
	readonly moduleId: string;
	readonly key: string;
	readonly definition: string;
	readonly baseUrl: string;
	/** Absent keeps the sealed credential and its kind; a new instance without it is kind none. */
	readonly credentials?: ConnectorModuleCredentials | undefined;
	readonly allowedHosts: readonly string[];
	readonly allowAgents: boolean;
	readonly allowWorkflows: boolean;
	readonly actor: string;
}

/** A module-owned instance as its module sees it. A credential never appears here. */
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

export interface ConnectorInstancesCapability {
	upsertModuleInstance(
		input: ConnectorModuleInstanceInput,
	): Promise<ConnectorModuleInstance>;
	describeModuleInstance(input: {
		readonly tenantId: string;
		readonly moduleId: string;
		readonly key: string;
	}): Promise<ConnectorModuleInstance | null>;
}
