import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	APPROVALS_REQUESTS_CAPABILITY,
	type ApprovalsRequests,
} from './domain/capability.ts';
import type { ApprovalMember } from './domain/types.ts';
import {
	createApprovalsRoutes,
	createApprovalsRuntime,
} from './server/index.ts';
import { approvalsDataClasses } from './services/data-classes.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublisher,
} from './services/notifications.ts';
import {
	APPROVALS_MODULE_SETTINGS,
	approvalsDefaultExpiryDays,
	approvalsExpiryIntervalMs,
} from './settings.ts';

interface AuthMemberRecord {
	readonly accountId: string;
	readonly role: string;
	readonly status: string;
	readonly membershipStatus: string;
	readonly scopes: readonly string[];
}

/* A disabled account or a suspended membership decides nothing, so the two
   reads apply the same filter and answer the same shape. */
function activeMember(member: AuthMemberRecord): ApprovalMember | null {
	if (member.status !== 'active' || member.membershipStatus !== 'active') {
		return null;
	}
	return {
		accountId: member.accountId,
		roleKey: member.role,
		scopes: member.scopes,
	};
}

/* Who may decide is auth.core's answer, and it is asked at the moment a request
   opens and again at the moment a decision arrives, never cached, so a revoked
   role stops producing decisions immediately. */
function tenantMembers(
	context: PlatformServerContext,
): (tenantId: string) => Promise<readonly ApprovalMember[]> {
	return async (tenantId) =>
		(await (await context.auth.service()).listTenantMembers(tenantId)).flatMap(
			(member) => {
				const active = activeMember(member);
				return active ? [active] : [];
			},
		);
}

/* Judging one account reads one membership: the whole roll is auth.core's
   answer only when the eligibility snapshot has to be resolved. */
function tenantMember(
	context: PlatformServerContext,
): (tenantId: string, accountId: string) => Promise<ApprovalMember | null> {
	return async (tenantId, accountId) => {
		const member = await (
			await context.auth.service()
		).findTenantMember(tenantId, accountId);
		return member ? activeMember(member) : null;
	};
}

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createApprovalsRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		members: tenantMembers(context),
		member: tenantMember(context),
		defaultExpiryDays: (tenantId) =>
			approvalsDefaultExpiryDays(context.settings, tenantId),
		expiryIntervalMs: () => approvalsExpiryIntervalMs(context.settings),
		/* notifications.core is optional. The lookup happens when an event is
		   published, so a module composed after this one is found and an absent
		   one is a no-op. */
		notifications: () =>
			context.capabilities.get<NotificationPublisher>(
				NOTIFICATIONS_PUBLISH_CAPABILITY,
			),
	});
	/* The runtime opens its database leases lazily, so the capability is a
	   forwarder rather than a resolved object: registration must not force a
	   connection at composition time. */
	context.capabilities.register<ApprovalsRequests>(
		APPROVALS_REQUESTS_CAPABILITY,
		{
			open: async (input) => (await runtime.service()).capability().open(input),
			get: async (tenantId, id) =>
				(await runtime.service()).capability().get(tenantId, id),
			list: async (tenantId, filter) =>
				(await runtime.service()).capability().list(tenantId, filter),
			cancel: async (tenantId, id, actorAccountId) =>
				(await runtime.service())
					.capability()
					.cancel(tenantId, id, actorAccountId),
		},
	);
	/* The sweep, the export, the count and the erasure run here, on this
	   module's own lease and under its own tenant transaction; the platform only
	   holds the declaration. */
	context.dataClasses.declare(approvalsDataClasses(() => runtime.repository()));
	return {
		routes: createApprovalsRoutes(context.auth, runtime),
		settings: APPROVALS_MODULE_SETTINGS,
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
