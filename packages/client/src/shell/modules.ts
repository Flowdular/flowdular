import { REQUIRED_MODULE_IDS } from '@flowdular/contracts';
import type {
	ModuleClientContribution,
	ModuleClientInitializationContext,
} from '../contributions.ts';

const REQUIRED = new Set<string>(REQUIRED_MODULE_IDS);

export type ActiveModulesLoader = (
	context: ModuleClientInitializationContext,
) => Promise<readonly string[] | null>;

/**
 * The contributions the workspace may show: every required module, and the
 * optional ones the workspace has active. `null` means the activation could
 * not be read, and the shell shows everything rather than nothing; the server
 * gate still refuses the API of an inactive module.
 */
export function contributionsForActiveModules(
	contributions: readonly ModuleClientContribution[],
	activeModules: readonly string[] | null,
): readonly ModuleClientContribution[] {
	if (activeModules === null) return contributions;
	const active = new Set(activeModules);
	return contributions.filter(
		(contribution) =>
			REQUIRED.has(contribution.moduleId) || active.has(contribution.moduleId),
	);
}

/* system.core answers the active composed module ids to any member of the
   workspace; an application without it, or a failed read, answers null. */
export const loadActiveModules: ActiveModulesLoader = async (context) => {
	try {
		const response = await fetch('/api/system/modules/active', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
			signal: context.signal,
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { modules?: unknown };
		return Array.isArray(body.modules) &&
			body.modules.every((id) => typeof id === 'string')
			? (body.modules as string[])
			: null;
	} catch {
		return null;
	}
};
