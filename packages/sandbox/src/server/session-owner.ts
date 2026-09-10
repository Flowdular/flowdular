import type { SandboxSession, SessionOwner } from './sessions.ts';

export function ownsSession(
	session: SandboxSession,
	owner: SessionOwner | null,
): boolean {
	return Boolean(
		owner &&
			session.owner &&
			session.owner.accountId === owner.accountId &&
			session.owner.tenantId === owner.tenantId &&
			session.owner.platformUrl.replace(/\/+$/, '') ===
				owner.platformUrl.replace(/\/+$/, ''),
	);
}

export function canReadSession(
	session: SandboxSession,
	owner: SessionOwner | null,
	local: boolean,
): boolean {
	return ownsSession(session, owner) || (local && !session.owner);
}
