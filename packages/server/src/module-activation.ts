import type { ServerRoute } from '@octanejs/app-core';
import { REQUIRED_MODULE_IDS } from '@flowdular/contracts';

/**
 * Answers whether a composed module is active in one workspace. system.core
 * installs the platform's gate; without one every module is active.
 */
export interface ModuleActivationGate {
	isActive(tenantId: string, moduleId: string): boolean | Promise<boolean>;
}

export const MODULE_INACTIVE = 'MODULE_INACTIVE';

const REQUIRED = new Set<string>(REQUIRED_MODULE_IDS);
const routeModules = new WeakMap<ServerRoute, string>();
let gate: ModuleActivationGate | null = null;

export function isRequiredModule(moduleId: string): boolean {
	return REQUIRED.has(moduleId);
}

/** The module id the generated composition bound the route to, if any. */
export function moduleOfRoute(route: ServerRoute): string | null {
	return routeModules.get(route) ?? null;
}

export function bindModuleRoutes<T extends readonly ServerRoute[]>(
	routes: T,
	moduleId: string,
): T {
	for (const route of routes) routeModules.set(route, moduleId);
	return routes;
}

/* Called by the generated composition with the module id it assigned, so an
   endpoint learns its owner without every module restating it. */
export function bindModuleCompositions<
	T extends {
		readonly moduleId?: string;
		readonly routes: readonly ServerRoute[];
	},
>(compositions: readonly T[]): readonly T[] {
	for (const composition of compositions) {
		if (composition.moduleId) {
			bindModuleRoutes(composition.routes, composition.moduleId);
		}
	}
	return compositions;
}

export function installModuleActivationGate(
	next: ModuleActivationGate | null,
): void {
	gate = next;
}

/**
 * True unless a gate is installed, the route belongs to an optional module and
 * that gate answers inactive for the tenant.
 */
export async function routeActiveForTenant(
	route: ServerRoute,
	tenantId: string,
): Promise<boolean> {
	if (!gate) return true;
	const moduleId = routeModules.get(route);
	if (moduleId === undefined || REQUIRED.has(moduleId)) return true;
	return gate.isActive(tenantId, moduleId);
}
