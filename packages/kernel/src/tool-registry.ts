/* Tools a module offers to agent runs. Modules register during composition;
   the agent runtime reads the list when it starts, after every module ran. */
export interface PlatformToolRegistry<T = unknown> {
	register(tools: readonly T[]): void;
	list(): readonly T[];
}

export function createPlatformToolRegistry<
	T extends { readonly id: string },
>(): PlatformToolRegistry<T> {
	const tools = new Map<string, T>();
	return {
		register(entries) {
			for (const tool of entries) {
				if (tools.has(tool.id)) {
					throw new Error(`Agent tool ${tool.id} is already registered.`);
				}
				tools.set(tool.id, tool);
			}
		},
		list() {
			return [...tools.values()];
		},
	};
}
