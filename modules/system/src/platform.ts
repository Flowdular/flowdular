import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	installApplicationBranding,
	installModuleActivationGate,
} from '@flowdular/server';
import { brandingFromSettings } from './domain/branding.ts';
import {
	composedModules,
	SYSTEM_MODULES_CAPABILITY,
	type ComposedModule,
} from './domain/modules.ts';
import { createSystemRoutes } from './server/endpoints.ts';
import { readModuleCatalog } from './server/module-catalog.ts';
import { createSystemRuntime } from './server/runtime.ts';
import type { SystemModulesCapability } from './server/capability.ts';
import { SYSTEM_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	/* The composed set is baked at build, so the manifests are read once per
	   composition, which in development is once per reload. */
	let composed: readonly ComposedModule[] | null = null;
	const modules = () =>
		(composed ??= composedModules(
			readModuleCatalog(context.workspaceRoot).filter((entry) => entry.enabled),
		));
	const runtime = createSystemRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		modules,
		audit: async (actor, change) =>
			(await context.auth.service()).recordModuleActivation(actor, change),
	});
	const capability: SystemModulesCapability = {
		isActive: async (tenantId, moduleId) =>
			(await runtime.service()).isActive(tenantId, moduleId),
		activeIds: async (tenantId) =>
			(await runtime.service()).activeIds(tenantId),
	};
	context.capabilities.register(SYSTEM_MODULES_CAPABILITY, capability);
	installModuleActivationGate(capability);
	/* The application document asks for this once per request; the settings
	   runtime answers from the snapshot it primed at boot, so the read costs
	   no lookup and an owner's change is live. */
	installApplicationBranding(() => brandingFromSettings(context.settings));
	return {
		routes: createSystemRoutes({ ...context, activation: runtime }),
		settings: SYSTEM_MODULE_SETTINGS,
		dispose: async () => {
			installApplicationBranding(null);
			installModuleActivationGate(null);
			await runtime.dispose();
		},
	};
}
