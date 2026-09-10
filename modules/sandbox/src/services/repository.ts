import type {
	SandboxAccessGrant,
	SandboxAuditChainVerification,
	SandboxAuditEvent,
	SandboxAuditPage,
	SandboxSessionRecord,
} from '../domain/types.ts';

export type SandboxAuditDraft = Omit<
	SandboxAuditEvent,
	'id' | 'sequence' | 'previousHash' | 'eventHash'
>;

/** The database-agnostic business port. No driver type crosses it. */
export interface SandboxRepository {
	findGrant(
		tenantId: string,
		accountId: string,
	): Promise<SandboxAccessGrant | null>;
	listGrants(tenantId: string): Promise<readonly SandboxAccessGrant[]>;
	saveGrant(grant: SandboxAccessGrant): Promise<SandboxAccessGrant>;
	revokeGrant(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): Promise<SandboxAccessGrant | null>;
	findSession(
		tenantId: string,
		id: string,
	): Promise<SandboxSessionRecord | null>;
	listSessions(
		tenantId: string,
		limit: number,
	): Promise<readonly SandboxSessionRecord[]>;
	saveSession(session: SandboxSessionRecord): Promise<SandboxSessionRecord>;
	appendAuditEvent(event: SandboxAuditDraft): Promise<SandboxAuditEvent>;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly SandboxAuditEvent[]>;
	/* Keyset page over the tenant trail, newest first, cursor `occurredAt:sequence`. */
	pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): Promise<SandboxAuditPage>;
	verifyAuditChain(tenantId: string): Promise<boolean>;
	verifyAuditChainDetailed(
		tenantId: string,
	): Promise<SandboxAuditChainVerification>;
	/* Only a locally owned adapter closes; a leased handle is released by the
	   runtime that acquired it. */
	close?(): Promise<void>;
}
