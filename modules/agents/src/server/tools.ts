import type { AgentTool } from '@coreloom/harness';

export type ModuleAgentTools = readonly AgentTool[];

/* Business modules export their tools through this so the composition can
   collect `agentTools` under one type and a duplicate id fails at boot. */
export function defineModuleAgentTools(
	tools: readonly AgentTool[],
): ModuleAgentTools {
	const ids = new Set<string>();
	for (const tool of tools) {
		if (ids.has(tool.id)) {
			throw new Error(`Agent tool ${tool.id} is defined twice.`);
		}
		ids.add(tool.id);
	}
	return Object.freeze([...tools]);
}
