import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { tenantMailLocale } from './domain/locale.ts';
import { NOTIFICATIONS_PUBLISH_CAPABILITY } from './domain/publish.ts';
import type { NotificationPublisher } from './domain/publish.ts';
import {
	createNotificationsRoutes,
	createNotificationsRuntime,
} from './server/index.ts';
import { notificationsDataClasses } from './services/data-classes.ts';
import type { TenantMemberScopes } from './services/delivery-service.ts';
import {
	NOTIFICATIONS_MODULE_SETTINGS,
	notificationsDeliverySettings,
	notificationsEgressAllowlist,
	notificationsPollIntervalMs,
} from './settings.ts';

/* The dead letter has to reach everyone who may read deliveries, and auth.core
   owns that answer; the e-mail channel resolves a member's address the same
   way. Both are asked while the work is done and held for one poll pass at
   most, so a revoked scope or a changed address takes effect immediately. */
function tenantMembers(
	context: PlatformServerContext,
): (tenantId: string) => Promise<readonly TenantMemberScopes[]> {
	return async (tenantId) =>
		(await (await context.auth.service()).listTenantMembers(tenantId))
			.filter((member) => member.status === 'active')
			.map((member) => ({
				accountId: member.accountId,
				email: member.email,
				scopes: member.scopes,
			}));
}

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createNotificationsRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		environment: context.environment,
		workspaceRoot: context.workspaceRoot,
		deliverySettings: (tenantId) =>
			notificationsDeliverySettings(context.settings, tenantId),
		egressAllowlist: () => notificationsEgressAllowlist(context.settings),
		pollIntervalMs: () => notificationsPollIntervalMs(context.settings),
		members: tenantMembers(context),
		mail: context.mail,
		locale: (tenantId) => tenantMailLocale(context.settings, tenantId),
	});
	/* Publishers resolve this and continue without notifying when it is absent,
	   so it is registered before anything can start producing events. */
	context.capabilities.register<NotificationPublisher>(
		NOTIFICATIONS_PUBLISH_CAPABILITY,
		{ publish: async (input) => (await runtime.publisher()).publish(input) },
	);
	/* The catalogue is sealed before start hooks run, so what this module holds
	   is declared here rather than on the first request. The sweep and the
	   export run on this module's own leases, under its own tenant transaction. */
	context.dataClasses.declare(
		notificationsDataClasses(() => runtime.repository()),
	);
	return {
		routes: createNotificationsRoutes(context.auth, runtime),
		settings: NOTIFICATIONS_MODULE_SETTINGS,
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
