import type {
	SandboxAccessGrant,
	SandboxAuditEvent,
	SandboxSessionRecord,
} from '../domain/types.ts';

export type SandboxAuditDraft = Omit<
	SandboxAuditEvent,
	'id' | 'sequence' | 'previousHash' | 'eventHash'
>;

export interface SandboxRepository {
	findGrant(tenantId: string, accountId: string): SandboxAccessGrant | null;
	listGrants(tenantId: string): readonly SandboxAccessGrant[];
	saveGrant(grant: SandboxAccessGrant): SandboxAccessGrant;
	revokeGrant(
		tenantId: string,
		accountId: string,
		revokedAt: number,
		revokedBy: string,
	): SandboxAccessGrant | null;
	findSession(tenantId: string, id: string): SandboxSessionRecord | null;
	listSessions(
		tenantId: string,
		limit: number,
	): readonly SandboxSessionRecord[];
	saveSession(session: SandboxSessionRecord): SandboxSessionRecord;
	appendAuditEvent(event: SandboxAuditDraft): SandboxAuditEvent;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): readonly SandboxAuditEvent[];
	verifyAuditChain(tenantId: string): boolean;
	close(): void;
}
