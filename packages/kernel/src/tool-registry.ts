/* Tools a module offers to agent runs. Modules register during composition;
   the agent runtime reads the list when it starts, after every module ran. */
export interface PlatformToolRegistry<T = unknown, N = unknown> {
	register(tools: readonly T[]): void;
	list(): readonly T[];
	/* A tool the model provider executes itself, such as a web search. It
	   shares the id space of `register`, because a run grants both by id. */
	registerNative(tool: N): void;
	listNative(): readonly N[];
}

export function createPlatformToolRegistry<
	T extends { readonly id: string },
	N extends { readonly id: string } = { readonly id: string },
>(): PlatformToolRegistry<T, N> {
	const tools = new Map<string, T>();
	const nativeTools = new Map<string, N>();
	return {
		register(entries) {
			for (const tool of entries) {
				if (tools.has(tool.id) || nativeTools.has(tool.id)) {
					throw new Error(`Agent tool ${tool.id} is already registered.`);
				}
				tools.set(tool.id, tool);
			}
		},
		list() {
			return [...tools.values()];
		},
		registerNative(tool) {
			if (tools.has(tool.id) || nativeTools.has(tool.id)) {
				throw new Error(`Agent tool ${tool.id} is already registered.`);
			}
			nativeTools.set(tool.id, tool);
		},
		listNative() {
			return [...nativeTools.values()];
		},
	};
}
