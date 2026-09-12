import type {
	NavigationContribution,
	RegisteredModule,
} from '@flowdular/contracts';
import {
	assertModuleCompatibility,
	assertModuleDependency,
} from './module-compatibility.ts';
import { RegistryError } from './errors.ts';

function compareModules(
	left: RegisteredModule,
	right: RegisteredModule,
): number {
	return left.manifest.id.localeCompare(right.manifest.id);
}

/* Every provider of a capability id, by module id. A capability has one
   provider: two modules registering the same id would race at composition. */
export function capabilityProviders(
	modules: Iterable<RegisteredModule>,
): ReadonlyMap<string, string> {
	const providers = new Map<string, string>();
	for (const module of modules) {
		for (const capability of module.manifest.provides ?? []) {
			const existing = providers.get(capability);
			if (existing && existing !== module.manifest.id) {
				throw new RegistryError(
					'MODULE_CAPABILITY_DUPLICATE',
					`Capability "${capability}" is provided by both "${existing}" and "${module.manifest.id}".`,
				);
			}
			providers.set(capability, module.manifest.id);
		}
	}
	return providers;
}

function visitModule(
	id: string,
	modules: ReadonlyMap<string, RegisteredModule>,
	providers: ReadonlyMap<string, string>,
	visiting: Set<string>,
	visited: Set<string>,
	ordered: RegisteredModule[],
): void {
	if (visited.has(id)) return;
	if (visiting.has(id)) {
		throw new RegistryError(
			'MODULE_DEPENDENCY_CYCLE',
			`Dependency cycle detected at "${id}".`,
		);
	}

	const current = modules.get(id);
	if (!current) {
		throw new RegistryError(
			'MODULE_NOT_FOUND',
			`Module "${id}" is not registered.`,
		);
	}

	visiting.add(id);
	for (const dependency of [...current.manifest.dependencies].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		if (!modules.has(dependency.id)) {
			throw new RegistryError(
				'MODULE_DEPENDENCY_MISSING',
				`Module "${id}" requires missing module "${dependency.id}".`,
			);
		}
		assertModuleDependency(
			id,
			dependency,
			modules.get(dependency.id)!.manifest.version,
		);
		visitModule(dependency.id, modules, providers, visiting, visited, ordered);
	}
	/* A required capability orders its provider first, like a dependency. An
	   optional one is resolved lazily by the consumer, so it neither fails when
	   absent nor takes part in ordering. */
	for (const requirement of [...(current.manifest.requires ?? [])].sort(
		(a, b) => a.id.localeCompare(b.id),
	)) {
		if (requirement.optional) continue;
		const provider = providers.get(requirement.id);
		if (!provider) {
			throw new RegistryError(
				'MODULE_CAPABILITY_MISSING',
				`Module "${id}" requires capability "${requirement.id}" and no registered module provides it.`,
			);
		}
		if (provider === id) continue;
		visitModule(provider, modules, providers, visiting, visited, ordered);
	}
	visiting.delete(id);
	visited.add(id);
	ordered.push(current);
}

export interface ModuleRegistry {
	readonly modules: readonly RegisteredModule[];
	get(id: string): RegisteredModule | undefined;
	has(id: string): boolean;
	navigation(
		permissions?: ReadonlySet<string>,
	): readonly NavigationContribution[];
}

export function createModuleRegistry(
	input: readonly RegisteredModule[],
): ModuleRegistry {
	const byId = new Map<string, RegisteredModule>();
	const navigationIds = new Set<string>();

	for (const module of input) {
		assertModuleCompatibility(module.manifest);
		if (byId.has(module.manifest.id)) {
			throw new RegistryError(
				'MODULE_DUPLICATE',
				`Module "${module.manifest.id}" is registered more than once.`,
			);
		}
		byId.set(module.manifest.id, module);

		for (const item of module.navigation ?? []) {
			if (navigationIds.has(item.id)) {
				throw new RegistryError(
					'NAVIGATION_DUPLICATE',
					`Navigation contribution "${item.id}" is registered more than once.`,
				);
			}
			navigationIds.add(item.id);
		}
	}

	const providers = capabilityProviders(byId.values());
	const ordered: RegisteredModule[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	for (const module of [...input].sort(compareModules)) {
		visitModule(
			module.manifest.id,
			byId,
			providers,
			visiting,
			visited,
			ordered,
		);
	}

	return Object.freeze({
		modules: Object.freeze(ordered),
		get: (id: string) => byId.get(id),
		has: (id: string) => byId.has(id),
		navigation: (permissions?: ReadonlySet<string>) =>
			Object.freeze(
				ordered
					.flatMap((module) => module.navigation ?? [])
					.filter(
						(item) => !item.permission || permissions?.has(item.permission),
					)
					.sort(
						(left, right) =>
							(left.order ?? 1000) - (right.order ?? 1000) ||
							left.id.localeCompare(right.id),
					),
			),
	});
}
