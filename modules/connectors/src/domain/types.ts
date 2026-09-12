export const CONNECTOR_AUTH_KINDS = [
	'none',
	'api-key',
	'bearer',
	'oauth2-client-credentials',
] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const CONNECTOR_METHODS = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const;
export type ConnectorMethod = (typeof CONNECTOR_METHODS)[number];

export const CONNECTOR_INSTANCE_STATUSES = ['active', 'disabled'] as const;
export type ConnectorInstanceStatus =
	(typeof CONNECTOR_INSTANCE_STATUSES)[number];

export const CONNECTOR_CALLERS = ['test', 'workflow', 'agent'] as const;
export type ConnectorCaller = (typeof CONNECTOR_CALLERS)[number];

export const CONNECTOR_CALL_OUTCOMES = [
	'succeeded',
	'failed',
	'refused',
] as const;
export type ConnectorCallOutcome = (typeof CONNECTOR_CALL_OUTCOMES)[number];

/**
 * The closed set the call log stores. `refused` outcomes never reached the
 * network; `failed` ones did, or were stopped by the transport itself.
 */
export const CONNECTOR_ERROR_CLASSES = [
	'egress-refused',
	'instance-disabled',
	'consent-missing',
	'definition-missing',
	'operation-unknown',
	'invalid-input',
	'credential-unavailable',
	'dns',
	'timeout',
	'network',
	'response-4xx',
	'response-5xx',
	'response-too-large',
] as const;
export type ConnectorErrorClass = (typeof CONNECTOR_ERROR_CLASSES)[number];

/** One operation of a definition. `path` is a template over the base URL. */
export interface ConnectorOperation {
	readonly key: string;
	readonly label: string;
	readonly method: ConnectorMethod;
	/**
	 * `{name}` expands one path segment and `{+name}` expands a whole path,
	 * both from the call input. Nothing else is substituted.
	 */
	readonly path: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema: Readonly<Record<string, unknown>>;
}

export interface ConnectorDefinition {
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly authKinds: readonly ConnectorAuthKind[];
	readonly operations: readonly ConnectorOperation[];
	/**
	 * Hosts an instance of this definition may reach. Empty means the definition
	 * names no host of its own and the instance allowlist is the only bound.
	 */
	readonly defaultAllowedHosts: readonly string[];
	/**
	 * Ports an instance of this definition may reach. Absent means 443 only; a
	 * definition that needs another port names every port it accepts, so an
	 * instance can never be aimed at a service that answers on an unnamed one.
	 */
	readonly allowedPorts?: readonly number[] | undefined;
}

/** An instance as every reader sees it. A credential never appears here. */
export interface ConnectorInstance {
	readonly id: string;
	readonly tenantId: string;
	readonly definitionKey: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly authKind: ConnectorAuthKind;
	readonly credentialFingerprint: string | null;
	readonly allowedHosts: readonly string[];
	readonly allowWorkflows: boolean;
	readonly allowAgents: boolean;
	readonly status: ConnectorInstanceStatus;
	readonly lastCallAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ConnectorCall {
	readonly id: string;
	readonly tenantId: string;
	readonly instanceId: string;
	readonly operation: string;
	readonly caller: ConnectorCaller;
	readonly callerRef: string | null;
	readonly outcome: ConnectorCallOutcome;
	readonly status: number | null;
	readonly errorClass: ConnectorErrorClass | null;
	readonly durationMs: number;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly occurredAt: number;
}

export type ConnectorCredentials =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'api-key';
			readonly header: string;
			readonly value: string;
	  }
	| { readonly kind: 'bearer'; readonly token: string }
	| {
			readonly kind: 'oauth2-client-credentials';
			readonly tokenUrl: string;
			readonly clientId: string;
			readonly clientSecret: string;
			readonly scope: string | null;
	  };

export interface CreateConnectorInstanceInput {
	readonly definitionKey: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly authKind: ConnectorAuthKind;
	/** Accepted once and sealed; never returned again. */
	readonly credentials: Record<string, unknown>;
	readonly allowedHosts: readonly string[];
}

export interface UpdateConnectorInstanceInput {
	readonly name: string;
	readonly baseUrl: string;
	readonly allowedHosts: readonly string[];
	/** Absent keeps the sealed credential the instance already holds. */
	readonly credentials?: Record<string, unknown> | undefined;
}

export interface ConnectorConsentInput {
	readonly allowWorkflows: boolean;
	readonly allowAgents: boolean;
	/** The owner's explicit confirmation, recorded with the audit row. */
	readonly confirmed: boolean;
}

export const CONNECTOR_AUDIT_ACTIONS = [
	'instance.created',
	'instance.updated',
	'instance.consent-changed',
	'instance.enabled',
	'instance.disabled',
	'instance.deleted',
] as const;
export type ConnectorAuditAction = (typeof CONNECTOR_AUDIT_ACTIONS)[number];

export interface ConnectorAuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly actorId: string;
	readonly action: ConnectorAuditAction;
	readonly instanceId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
}
