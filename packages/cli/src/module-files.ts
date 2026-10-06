import {
	findModuleManifests,
	moduleRootDirectories,
} from '@flowdular/kernel/module-manifests';
import type { Workspace } from './workspace.ts';

function configuredRoots(workspace: Workspace): unknown {
	return (workspace.config.modules as { roots?: unknown } | undefined)?.roots;
}

export function moduleRoots(workspace: Workspace): string[] {
	return [...moduleRootDirectories(workspace.root, configuredRoots(workspace))];
}

export async function findModuleFiles(workspace: Workspace): Promise<string[]> {
	return [...findModuleManifests(workspace.root, configuredRoots(workspace))];
}
