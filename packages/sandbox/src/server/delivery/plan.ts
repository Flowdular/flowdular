import { join, relative } from 'node:path';
import { basePathOf, modulePathOf, sessionPaths } from '../sessions.ts';
import { SandboxSetupError } from '../workspace-root.ts';
import { newPackages, planModuleFiles } from './steps.ts';
import type { DeliveryContext, DeliveryModulePlan } from './types.ts';

export const GATES = [
	'spec-schema',
	'module-schema',
	'dependencies',
	'typecheck',
	'tests',
	'format',
] as const;

export function assertEjectCapability(context: DeliveryContext): void {
	if (!context.capabilities.includes('sandbox.modules.eject')) {
		throw new SandboxSetupError(
			'EJECT_SCOPE_MISSING',
			'The sandbox grant does not include sandbox.modules.eject.',
		);
	}
}

/* What every module of the session changes in modules/ of this workspace. Both
   targets start from this; only where the files go differs. */
export async function planSessionModules(
	context: DeliveryContext,
): Promise<readonly DeliveryModulePlan[]> {
	const paths = sessionPaths(
		context.workspaceRoot,
		context.session.id,
		context.session.moduleSuffix,
	);
	const modules: DeliveryModulePlan[] = [];
	for (const module of context.session.modules) {
		const sourcePath = modulePathOf(paths, module.directory);
		const targetPath = join(context.workspaceRoot, 'modules', module.directory);
		const changes = await planModuleFiles(
			sourcePath,
			targetPath,
			module.kind === 'edit' ? basePathOf(paths, module.directory) : null,
		);
		if (changes.files.length === 0) {
			throw new SandboxSetupError(
				'EJECT_EMPTY',
				`The session workspace holds no files for ${module.id} yet.`,
			);
		}
		modules.push({
			id: module.id,
			directory: module.directory,
			kind: module.kind,
			targetPath: relative(context.workspaceRoot, targetPath),
			...changes,
			newPackages: await newPackages(
				context.workspaceRoot,
				sourcePath,
				targetPath,
			),
			enable: module.kind === 'new',
		});
	}
	return modules;
}

/* Every draft file plus every removal, as the workspace target reports it. */
export function countDeliveredFiles(
	modules: readonly DeliveryModulePlan[],
): number {
	return modules.reduce(
		(total, module) =>
			total +
			module.files.filter((file) => !module.overwrites.includes(file)).length +
			module.overwrites.length +
			module.removes.length,
		0,
	);
}

/* Only what differs from the target: new files, changed files, removals. */
export function countChangedFiles(
	modules: readonly DeliveryModulePlan[],
): number {
	return modules.reduce(
		(total, module) =>
			total +
			module.additions.length +
			module.overwrites.length +
			module.removes.length,
		0,
	);
}
