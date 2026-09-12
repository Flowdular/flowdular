/* Public services exposed between composed modules. The registry owns only
   identities and lifetimes; each provider owns the capability's types. */
export interface PlatformCapabilityRegistry {
	register<T>(id: string, capability: T): void;
	get<T>(id: string): T | null;
	has(id: string): boolean;
	/* A view bound to one module's manifest declaration: register accepts only
	   the ids under `provides`, get and has only the ids under `requires`; ids
	   under `platform.` are kernel-owned and stay open both ways. The generated
	   composition hands each module this view so the manifest stays the truth
	   about who talks to whom. */
	forModule(
		moduleId: string,
		declaration: ModuleCapabilityDeclaration,
	): PlatformCapabilityRegistry;
}

export interface ModuleCapabilityDeclaration {
	readonly provides?: readonly string[];
	readonly requires?: readonly {
		readonly id: string;
		readonly optional?: boolean;
	}[];
}

const CAPABILITY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PLATFORM_PREFIX = 'platform.';

export function createPlatformCapabilityRegistry(): PlatformCapabilityRegistry {
	const capabilities = new Map<string, unknown>();
	const root: PlatformCapabilityRegistry = {
		register(id, capability) {
			if (!CAPABILITY_ID.test(id)) {
				throw new Error(`Platform capability ${id} has an invalid id.`);
			}
			if (capabilities.has(id)) {
				throw new Error(`Platform capability ${id} is already registered.`);
			}
			capabilities.set(id, capability);
		},
		get<T>(id: string): T | null {
			return (capabilities.get(id) as T | undefined) ?? null;
		},
		has(id) {
			return capabilities.has(id);
		},
		forModule(moduleId, declaration) {
			return scopedCapabilityRegistry(root, moduleId, declaration);
		},
	};
	return root;
}

function scopedCapabilityRegistry(
	root: PlatformCapabilityRegistry,
	moduleId: string,
	declaration: ModuleCapabilityDeclaration,
): PlatformCapabilityRegistry {
	const provides = new Set(declaration.provides ?? []);
	const requires = new Set(
		(declaration.requires ?? []).map((entry) => entry.id),
	);
	const readable = (id: string) =>
		requires.has(id) || provides.has(id) || id.startsWith(PLATFORM_PREFIX);
	const scoped: PlatformCapabilityRegistry = {
		register(id, capability) {
			if (!provides.has(id) && !id.startsWith(PLATFORM_PREFIX)) {
				throw new Error(
					`${moduleId} registers capability ${id} without declaring it under "provides" in module.json.`,
				);
			}
			root.register(id, capability);
		},
		get<T>(id: string): T | null {
			if (!readable(id)) {
				throw new Error(
					`${moduleId} resolves capability ${id} without declaring it under "requires" in module.json.`,
				);
			}
			return root.get<T>(id);
		},
		has(id) {
			if (!readable(id)) {
				throw new Error(
					`${moduleId} checks capability ${id} without declaring it under "requires" in module.json.`,
				);
			}
			return root.has(id);
		},
		forModule(nestedModuleId, nestedDeclaration) {
			return scopedCapabilityRegistry(root, nestedModuleId, nestedDeclaration);
		},
	};
	return scoped;
}
