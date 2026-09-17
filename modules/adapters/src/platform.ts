import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import type { AuthPrincipal } from '@flowdular/module-auth';
import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	ADAPTERS_SINKS_CAPABILITY,
	ADAPTERS_SOURCES_CAPABILITY,
	type AdapterRegistry,
} from './domain/registry.ts';
import { ADAPTERS_MODULE_ID } from './domain/types.ts';
import { createAdaptersRoutes, createAdaptersRuntime } from './server/index.ts';
import {
	CONNECTORS_CALLS_CAPABILITY,
	EXPORT_LISTS_CAPABILITY,
	IMPORT_WRITE_CAPABILITY,
	METERING_METERS_CAPABILITY,
	type ConnectorCalls,
	type ExportLists,
	type ImportWriter,
	type MeterRegistry,
} from './services/capabilities.ts';
import { adaptersDataClasses } from './services/data-classes.ts';
import { adaptersListExports } from './services/list-exports.ts';

/* A run acts for a member resolved live, so a disabled account, a suspended
   membership and a revoked grant stop the next run rather than the next deploy. */
export function activePrincipal(
	context: PlatformServerContext,
): (tenantId: string, accountId: string) => Promise<AuthPrincipal | null> {
	return async (tenantId, accountId) => {
		const member = await (
			await context.auth.service()
		).findTenantMember(tenantId, accountId);
		if (
			!member ||
			member.status !== 'active' ||
			member.membershipStatus !== 'active'
		) {
			return null;
		}
		return {
			accountId: member.accountId,
			tenantId,
			email: member.email,
			displayName: member.displayName,
			role: member.role,
			scopes: member.scopes,
			tenants: [],
		};
	};
}

/* The shared system.core zone, read through the settings runtime. A workspace
   that set nothing, a deployment without system.core and a zone this runtime
   does not know all fire in UTC, because a schedule must keep firing. */
export function workspaceTimeZone(
	context: PlatformServerContext,
): (tenantId: string) => Promise<string> {
	return async (tenantId) => {
		try {
			await context.settings.prime(tenantId);
			const zone = context.settings.get<string>(
				tenantId,
				TENANT_TIME_ZONE_SETTING.moduleId,
				TENANT_TIME_ZONE_SETTING.key,
			);
			new Intl.DateTimeFormat('en-US', { timeZone: zone });
			return zone;
		} catch {
			return TENANT_TIME_ZONE_SETTING.defaultValue;
		}
	};
}

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const capabilities = context.capabilities;
	const meters = () =>
		capabilities.get<MeterRegistry>(METERING_METERS_CAPABILITY) ?? undefined;
	const lists = () =>
		capabilities.get<ExportLists>(EXPORT_LISTS_CAPABILITY) ?? undefined;
	const runtime = createAdaptersRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		calls: () =>
			capabilities.get<ConnectorCalls>(CONNECTORS_CALLS_CAPABILITY) ??
			undefined,
		writer: () =>
			capabilities.get<ImportWriter>(IMPORT_WRITE_CAPABILITY) ?? undefined,
		lists,
		meters,
		principal: activePrincipal(context),
		timeZone: workspaceTimeZone(context),
		recordedAllowed: context.environment.NODE_ENV !== 'production',
	});
	capabilities.register<AdapterRegistry>(ADAPTERS_SOURCES_CAPABILITY, {
		register: (moduleId, adapters) =>
			runtime.catalogue.sources.register(moduleId, adapters),
	});
	capabilities.register<AdapterRegistry>(ADAPTERS_SINKS_CAPABILITY, {
		register: (moduleId, adapters) =>
			runtime.catalogue.sinks.register(moduleId, adapters),
	});
	context.dataClasses.declare(
		ADAPTERS_MODULE_ID,
		adaptersDataClasses(() => runtime.repository()),
	);

	/* Both registries are optional and an optional requirement does not order
	   its provider first, so each is asked for while this module composes and
	   again at start, before its provider seals it. */
	let metersDeclared = false;
	let listsRegistered = false;
	const registerOptional = (): void => {
		const registry = meters();
		if (!metersDeclared && registry) {
			metersDeclared = true;
			registry.declare(ADAPTERS_MODULE_ID, [
				{
					key: 'rows',
					label: 'Data adapter rows written',
					labelKey: 'adapters.meter.rows',
					unit: 'rows',
					unitKey: 'adapters.meter.rows.unit',
					kind: 'cumulative',
				},
			]);
		}
		const exportLists = lists();
		if (!listsRegistered && exportLists) {
			listsRegistered = true;
			exportLists.register(
				ADAPTERS_MODULE_ID,
				adaptersListExports(() => runtime.service()),
			);
		}
	};
	registerOptional();
	return {
		routes: createAdaptersRoutes(context.auth, runtime),
		start: () => {
			registerOptional();
			/* Every module has composed and started registering by now, so the
			   catalogue a run is queued against is complete and closed. */
			runtime.catalogue.seal();
			runtime.start();
		},
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
