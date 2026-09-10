import { resolveInside, type Workspace } from './workspace.ts';
import { findNamedFiles } from './validation.ts';

export function agentResource(
	workspace: Workspace,
	key: 'policy' | 'modelRouting' | 'blueprints',
): string {
	const defaults = {
		policy: '.ai/policies/capabilities.yaml',
		modelRouting: '.ai/policies/model-routing.yaml',
		blueprints: '.ai/blueprints',
	};
	const agent = workspace.config.agent as Record<string, unknown> | undefined;
	const path = agent?.[key] ?? defaults[key];
	if (typeof path !== 'string' || !path)
		throw new Error(`Invalid agent.${key} path.`);
	return resolveInside(workspace.root, path);
}
export function findBlueprintFiles(workspace: Workspace): Promise<string[]> {
	return findNamedFiles(
		agentResource(workspace, 'blueprints'),
		'blueprint.json',
	);
}
