/* Business modules register code-owned agent definitions while the platform is
	 composing. The registry becomes an immutable catalog before start hooks run. */
export interface PlatformAgentRegistry<T = unknown> {
	register(definitions: readonly T[]): void;
	list(): readonly T[];
	/** Returns a registrar that accepts definitions owned by one module only. */
	forModule(moduleId: string): PlatformAgentRegistry<T>;
}

export interface MutablePlatformAgentRegistry<T>
	extends PlatformAgentRegistry<T> {
	seal(): void;
}

export function createPlatformAgentRegistry<
	T extends { readonly id: string },
>(): MutablePlatformAgentRegistry<T> {
	const definitions = new Map<string, T>();
	let sealed: readonly T[] | null = null;
	const view = (boundModuleId?: string): PlatformAgentRegistry<T> => ({
		register(entries) {
			if (sealed !== null) {
				throw new Error('The platform agent registry is already sealed.');
			}

			/* Validate the whole batch before changing the registry. A duplicate must
			   never leave only part of one module's declaration registered. */
			const incoming = new Set<string>();
			for (const definition of entries) {
				if (
					boundModuleId !== undefined &&
					(definition as { readonly moduleId?: unknown }).moduleId !==
						boundModuleId
				) {
					throw new Error(
						`Module ${boundModuleId} cannot register an agent owned by ${String((definition as { readonly moduleId?: unknown }).moduleId ?? 'an unknown module')}.`,
					);
				}
				if (typeof definition.id !== 'string' || definition.id.length === 0) {
					throw new Error('A platform agent definition requires an id.');
				}
				if (definitions.has(definition.id) || incoming.has(definition.id)) {
					throw new Error(
						`Platform agent ${definition.id} is already registered.`,
					);
				}
				incoming.add(definition.id);
			}

			for (const definition of entries) {
				definitions.set(definition.id, definition);
			}
		},
		list() {
			return sealed ?? Object.freeze([...definitions.values()]);
		},
		forModule(moduleId) {
			const normalized = moduleId.trim();
			if (!normalized)
				throw new Error('A module-bound agent registry needs an id.');
			if (boundModuleId !== undefined && normalized !== boundModuleId) {
				throw new Error(
					`Module ${boundModuleId} cannot obtain the agent registrar for ${normalized}.`,
				);
			}
			return boundModuleId === normalized ? this : view(normalized);
		},
	});

	return {
		...view(),
		seal() {
			if (sealed !== null) return;
			sealed = Object.freeze(
				[...definitions.values()].sort((left, right) =>
					left.id.localeCompare(right.id),
				),
			);
		},
	};
}
