import type {
	ConnectorCaller,
	ConnectorCallOutcome,
	ConnectorErrorClass,
} from './types.ts';

/**
 * The capability a workflow action or an agent tool resolves to reach an
 * external system. It carries the caller kind because consent is granted per
 * caller: an instance may be open to workflows and closed to agents.
 */
export const CONNECTORS_CALLS_CAPABILITY = 'connectors.calls.v1';

export type ConnectorJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ConnectorJsonValue[]
	| { readonly [key: string]: ConnectorJsonValue };

export interface ConnectorCallRequest {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly operation: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly caller: ConnectorCaller;
	/** The run this call belongs to, recorded with the call. */
	readonly callerRef?: string | undefined;
	/**
	 * Binds this call to one durable key. A repeat of the key answers the call
	 * it already produced instead of reaching the external system again, so an
	 * unattended caller replayed after a crash writes at most once.
	 */
	readonly idempotencyKey?: string | undefined;
	readonly signal?: AbortSignal | undefined;
}

export interface ConnectorCallResult {
	readonly callId: string;
	readonly outcome: ConnectorCallOutcome;
	readonly status: number | null;
	readonly errorClass: ConnectorErrorClass | null;
	readonly durationMs: number;
	readonly requestBytes: number;
	readonly responseBytes: number;
	/** Parsed JSON response. Returned to the caller, never written to the log. */
	readonly body: ConnectorJsonValue | null;
	/** Bounded text of the response for diagnosis. Never written to the log. */
	readonly bodyPreview: string;
	/**
	 * True when the idempotency ledger answered with a call that already ran.
	 * Nothing left the process, and the log keeps no body, so `body` and
	 * `bodyPreview` are empty rather than the original answer.
	 */
	readonly replayed: boolean;
}

export interface ConnectorCallCapability {
	call(request: ConnectorCallRequest): Promise<ConnectorCallResult>;
	/**
	 * Whether this caller kind may use the instance right now. A caller that
	 * admits a tool before running it asks this instead of making a call.
	 */
	consented(
		tenantId: string,
		instanceId: string,
		caller: ConnectorCaller,
	): Promise<boolean>;
}
