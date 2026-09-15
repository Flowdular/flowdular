import { REQUIRED_MODULE_IDS } from '@flowdular/contracts';

export const SYSTEM_MODULES_CAPABILITY = 'system.modules.v1';

const REQUIRED = new Set<string>(REQUIRED_MODULE_IDS);

export function isRequiredModule(moduleId: string): boolean {
	return REQUIRED.has(moduleId);
}

/** One module the application composes, with the modules it cannot run without. */
export interface ComposedModule {
	readonly id: string;
	readonly version: string;
	readonly dependencies: readonly string[];
}

export interface ModuleActivationEntry {
	readonly id: string;
	readonly version: string;
	readonly active: boolean;
	/** False for a required module, which is never deactivated. */
	readonly optional: boolean;
	/** Composed modules that declare this one as a dependency. */
	readonly dependents: readonly string[];
}

export interface ModuleActivationChange {
	readonly moduleId: string;
	readonly active: boolean;
}

/** What other composed modules a public capability is served by. */
export interface ManifestDependencies {
	readonly id: string;
	readonly version: string;
	readonly dependencies: readonly string[];
	readonly provides: readonly string[];
	/** Capability ids the module cannot compose without. */
	readonly requires: readonly string[];
}

/* A dependency is a declared module dependency or a required capability,
   resolved to the composed module that provides it. */
export function composedModules(
	manifests: readonly ManifestDependencies[],
): readonly ComposedModule[] {
	const providers = new Map<string, string>();
	const ids = new Set(manifests.map((manifest) => manifest.id));
	for (const manifest of manifests) {
		for (const capability of manifest.provides) {
			providers.set(capability, manifest.id);
		}
	}
	return manifests.map((manifest) => {
		const dependencies = new Set<string>();
		for (const id of manifest.dependencies) {
			if (ids.has(id) && id !== manifest.id) dependencies.add(id);
		}
		for (const capability of manifest.requires) {
			const provider = providers.get(capability);
			if (provider !== undefined && provider !== manifest.id) {
				dependencies.add(provider);
			}
		}
		return {
			id: manifest.id,
			version: manifest.version,
			dependencies: [...dependencies].sort(),
		};
	});
}

export function dependentsOf(
	modules: readonly ComposedModule[],
	moduleId: string,
): readonly string[] {
	return modules
		.filter((module) => module.dependencies.includes(moduleId))
		.map((module) => module.id)
		.sort();
}

/** The composed module ids that are active for a workspace, sorted. */
export function activeModuleIds(
	modules: readonly ComposedModule[],
	inactive: ReadonlySet<string>,
): readonly string[] {
	return modules
		.map((module) => module.id)
		.filter((id) => isRequiredModule(id) || !inactive.has(id))
		.sort();
}
