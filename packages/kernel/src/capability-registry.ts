/* Public services exposed between composed modules. The registry owns only
   identities and lifetimes; each provider owns the capability's types. */
export interface PlatformCapabilityRegistry {
	register<T>(id: string, capability: T): void;
	get<T>(id: string): T | null;
	has(id: string): boolean;
}

export function createPlatformCapabilityRegistry(): PlatformCapabilityRegistry {
	const capabilities = new Map<string, unknown>();
	return {
		register(id, capability) {
			if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id)) {
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
	};
}
