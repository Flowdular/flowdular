import type { AuthRuntime } from '@flowdular/module-auth/server';
import type { AuditPosition } from '../domain/types.ts';
import type {
	AccessDirectory,
	DirectoryAuditEvent,
	DirectoryMember,
	DirectoryMemberPage,
	DirectoryProvider,
	DirectoryRole,
	DirectoryToken,
} from './directory.ts';

/* The auth service as the platform hands it over. Its class is not exported,
   and access.core needs no more of it than the runtime's own signature says. */
type AuthService = Awaited<ReturnType<AuthRuntime['service']>>;

/**
 * auth.core's audit query carries the window as an inclusive `from` and `to`
 * over `occurredAt`, applied in SQL beside the keyset, and pages on a cursor of
 * `${occurredAt}:${id}` that selects rows strictly before it, newest first.
 * This adapter states the window and hands the position over; it never seeds a
 * cursor at a ceiling or watches for a floor.
 */
function cursorOf(after: AuditPosition | null): string | null {
	return after === null ? null : `${after.occurredAt}:${after.id}`;
}

/**
 * The one place access.core depends on auth.core's read surface. Everything
 * here is a read of the acting principal's own workspace; access.core opens no
 * auth table and holds no copy of what it reads.
 */
export function authDirectory(auth: AuthRuntime): AccessDirectory {
	const service = (): Promise<AuthService> => auth.service();
	return {
		async members(tenantId): Promise<readonly DirectoryMember[]> {
			return (await service()).listTenantMembers(tenantId);
		},
		async memberPage(tenantId, cursor, limit): Promise<DirectoryMemberPage> {
			const page = await (
				await service()
			).listTenantMembers(tenantId, { cursor, limit });
			return { members: page.members, nextCursor: page.nextCursor };
		},
		async roles(tenantId): Promise<readonly DirectoryRole[]> {
			return (await service()).listRoles(tenantId);
		},
		async tokens(tenantId): Promise<readonly DirectoryToken[]> {
			return (await service()).listApiTokens(tenantId);
		},
		async providers(tenantId): Promise<readonly DirectoryProvider[]> {
			return (await service()).identityProviders.list(tenantId);
		},
		async auditPage(
			tenantId,
			window,
			after,
			limit,
		): Promise<readonly DirectoryAuditEvent[]> {
			const page = await (
				await service()
			).queryAudit({
				tenantId,
				from: window.from,
				to: window.to,
				limit,
				cursor: cursorOf(after),
			});
			return page.events;
		},
	};
}
