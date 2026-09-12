import type {
	ConnectorAuditEvent,
	ConnectorCall,
	ConnectorCallOutcome,
	ConnectorInstance,
	ConnectorInstanceStatus,
} from '../domain/types.ts';
import type { SealedCredential } from './credential-vault.ts';

export class DuplicateConnectorNameError extends Error {
	constructor() {
		super('A connector instance with this name already exists in the tenant.');
		this.name = 'DuplicateConnectorNameError';
	}
}

/** The instance plus the sealed credential. Only the call path reads this. */
export interface StoredConnectorInstance extends ConnectorInstance {
	readonly credential: SealedCredential | null;
}

export interface ConnectorCallFilters {
	readonly outcome?: ConnectorCallOutcome | undefined;
	readonly instanceId?: string | undefined;
}

/** Written in the same transaction as the change it describes. */
export type PendingConnectorAuditEvent = Omit<ConnectorAuditEvent, 'id'>;

/** What one attempt wants to bind an idempotency key to. */
export interface ConnectorCallKeyClaim {
	/** `<instanceId>:<operation>`; a key is never reused across operations. */
	readonly operationId: string;
	readonly inputDigest: string;
	readonly claimedAt: number;
	/** A claim older than this was abandoned and may be taken over. */
	readonly staleBefore: number;
}

/**
 * `claimed` means this attempt owns the key and must make the call; `replay`
 * names the call a previous attempt already produced; `in-flight` means another
 * attempt still holds the claim; `conflict` means the key is bound to a
 * different operation or input.
 */
export type ConnectorCallKeyDecision =
	| { readonly state: 'claimed' }
	| { readonly state: 'in-flight' }
	| { readonly state: 'conflict' }
	| { readonly state: 'replay'; readonly callId: string };

/** One keyset page of an export walk. */
export interface ConnectorExportCursor {
	readonly occurredAt: number;
	readonly id: string;
}

/** The database-agnostic business port. No driver type crosses it. */
export interface ConnectorsRepository {
	listInstances(tenantId: string): Promise<readonly ConnectorInstance[]>;
	findInstance(
		tenantId: string,
		id: string,
	): Promise<StoredConnectorInstance | null>;
	createInstance(
		record: StoredConnectorInstance,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance>;
	updateInstance(
		record: StoredConnectorInstance,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance>;
	setConsent(
		tenantId: string,
		id: string,
		consent: {
			readonly allowWorkflows: boolean;
			readonly allowAgents: boolean;
			readonly updatedAt: number;
		},
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance | null>;
	setStatus(
		tenantId: string,
		id: string,
		status: ConnectorInstanceStatus,
		updatedAt: number,
		audit: PendingConnectorAuditEvent,
	): Promise<ConnectorInstance | null>;
	/** Refuses an instance that is not disabled; the call log is left behind. */
	deleteInstance(
		tenantId: string,
		id: string,
		audit: PendingConnectorAuditEvent,
	): Promise<boolean>;
	/**
	 * Binds an idempotency key to this workspace before the call is made. The
	 * caller makes the call only for `claimed`.
	 */
	claimCallKey(
		tenantId: string,
		key: string,
		claim: ConnectorCallKeyClaim,
	): Promise<ConnectorCallKeyDecision>;
	findCall(tenantId: string, id: string): Promise<ConnectorCall | null>;
	/**
	 * Appends the call, moves the instance's last call time and binds the
	 * claimed idempotency key to it, in one write.
	 */
	recordCall(call: ConnectorCall, idempotencyKey: string | null): Promise<void>;
	/**
	 * Removes at most `limit` calls older than `before`, together with the
	 * idempotency keys claimed before it. A key is always claimed no later than
	 * its call, so this never leaves a key pointing at a call that is gone.
	 */
	deleteCallsBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	exportCallsPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorCall[]>;
	exportAuditPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorAuditEvent[]>;
	exportInstancesPage(
		tenantId: string,
		after: ConnectorExportCursor | null,
		limit: number,
	): Promise<readonly ConnectorInstance[]>;
	listCalls(
		tenantId: string,
		filters: ConnectorCallFilters,
		limit: number,
	): Promise<readonly ConnectorCall[]>;
	listAudit(
		tenantId: string,
		instanceId: string,
		limit: number,
	): Promise<readonly ConnectorAuditEvent[]>;
}
