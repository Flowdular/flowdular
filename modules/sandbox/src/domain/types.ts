export type SandboxGrantCapability =
	| 'sandbox.access.use'
	| 'sandbox.sessions.read'
	| 'sandbox.preview.data'
	| 'sandbox.modules.eject';

export interface SandboxAccessGrant {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly capabilities: readonly SandboxGrantCapability[];
	readonly note: string | null;
	readonly grantedBy: string;
	readonly grantedAt: number;
	readonly expiresAt: number | null;
	readonly revokedAt: number | null;
	readonly revokedBy: string | null;
}

export interface SandboxAccessCandidate {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly status: 'active' | 'disabled';
	readonly availableCapabilities: readonly SandboxGrantCapability[];
}

export type SandboxAuthorityDenial =
	| 'grant-missing'
	| 'grant-revoked'
	| 'grant-expired'
	| 'scope-missing';

export interface SandboxAuthorityGranted {
	readonly granted: true;
	readonly grantId: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly capabilities: readonly SandboxGrantCapability[];
	readonly expiresAt: number | null;
}

export interface SandboxAuthorityDenied {
	readonly granted: false;
	readonly reason: SandboxAuthorityDenial;
}

export type SandboxAuthority = SandboxAuthorityGranted | SandboxAuthorityDenied;

export type SandboxSessionState =
	| 'draft'
	| 'classified'
	| 'planned'
	| 'editing'
	| 'validating'
	| 'previewing'
	| 'awaiting-approval'
	| 'accepted'
	| 'failed'
	| 'blocked'
	| 'archived'
	| 'deleted';

export const SANDBOX_SESSION_STATES: readonly SandboxSessionState[] = [
	'draft',
	'classified',
	'planned',
	'editing',
	'validating',
	'previewing',
	'awaiting-approval',
	'accepted',
	'failed',
	'blocked',
	'archived',
	'deleted',
];

export type SandboxRuntimeMode = 'loopback' | 'self-hosted';

export interface SandboxSessionRecord {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly moduleId: string;
	readonly title: string;
	readonly blueprint: string;
	readonly driver: string;
	readonly mode: SandboxRuntimeMode;
	readonly state: SandboxSessionState;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly ejectedAt: number | null;
	readonly archivedAt: number | null;
}

export interface SandboxAuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly sequence: number;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: 'grant' | 'session' | 'module';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}
