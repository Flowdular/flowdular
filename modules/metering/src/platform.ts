import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	METERING_METERS_CAPABILITY,
	type MeterRegistry,
} from './domain/meters.ts';
import { createMeteringRoutes, createMeteringRuntime } from './server/index.ts';
import { meteringDataClasses } from './services/data-classes.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublisher,
} from './services/notifications.ts';
import {
	METERING_MODULE_SETTINGS,
	meteringWarningPercent,
} from './settings.ts';

/* A threshold reaches the people who answer for the workspace's spending, and
   auth.core owns that answer. It is asked when a threshold is crossed, never
   cached, so a change of owner reaches the next notification. */
function workspaceOwners(
	context: PlatformServerContext,
): (tenantId: string) => Promise<readonly string[]> {
	return async (tenantId) =>
		(await (await context.auth.service()).listTenantMembers(tenantId))
			.filter((member) => member.status === 'active' && member.role === 'owner')
			.map((member) => member.accountId);
}

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createMeteringRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		warningPercent: () => meteringWarningPercent(context.settings),
		owners: workspaceOwners(context),
		/* notifications.core is optional and is not a package dependency. The
		   lookup happens when a threshold is crossed, so a module composed after
		   this one is found and an absent one is a no-op. */
		notifications: () =>
			context.capabilities.get<NotificationPublisher>(
				NOTIFICATIONS_PUBLISH_CAPABILITY,
			),
	});
	/* Registered before any module composes so every declaring module resolves
	   it during its own composition; start() seals it once they all have. */
	context.capabilities.register<MeterRegistry>(
		METERING_METERS_CAPABILITY,
		runtime.meters,
	);
	/* The sweep and the export run here, on this module's own leases and under
	   its own tenant transaction; the platform only holds the declaration. */
	context.dataClasses.declare(
		'metering.core',
		meteringDataClasses(() => runtime.service()),
	);
	return {
		routes: createMeteringRoutes(context.auth, runtime),
		settings: METERING_MODULE_SETTINGS,
		start: () => runtime.start(),
		dispose: () => runtime.dispose(),
	};
}
