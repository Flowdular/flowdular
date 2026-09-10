import { join, relative } from 'node:path';
import {
	basePathOf,
	modulePathOf,
	sessionPaths,
	type SessionModule,
} from '../sessions.ts';
import {
	diffSpecs,
	isSpecApproved,
	parseModuleSpec,
	readSpecText,
	SPEC_FILE,
} from '../spec.ts';
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
	'auto-review',
] as const;

const NUMBERED_MIGRATION = /^migrations\/\d{4}_[^/]+\.(?:up|down)\.sql$/;

function assertExistingMigrationsUnchanged(
	module: SessionModule,
	overwrites: readonly string[],
	removes: readonly string[],
): void {
	const changed = [...overwrites, ...removes].filter((file) =>
		NUMBERED_MIGRATION.test(file),
	);
	if (changed.length === 0) return;
	throw new SandboxSetupError(
		'EJECT_MIGRATION_IMMUTABLE',
		`${module.id} changes an existing migration (${changed.join(', ')}). Restore the original bytes and add a new numbered migration instead.`,
	);
}

export function assertEjectCapability(context: DeliveryContext): void {
	if (!context.capabilities.includes('sandbox.modules.eject')) {
		throw new SandboxSetupError(
			'EJECT_SCOPE_MISSING',
			'The sandbox grant does not include sandbox.modules.eject.',
		);
	}
}

/* A change that landed without a specification behind it is how a module and
   its contract drift apart. Before an edited module is delivered its
   specification has to cover the change: the version moves, and at least one
   acceptance scenario is new or different. A module whose base copy carries no
   specification has nothing to compare, so it is left alone. */
async function assertSpecCoversChange(
	module: SessionModule,
	sourcePath: string,
	basePath: string,
	changedFiles: number,
): Promise<void> {
	const specPath = `modules/${module.directory}/${SPEC_FILE}`;
	const baseText = await readSpecText(basePath);
	if (baseText === null) return;
	const draftText = await readSpecText(sourcePath);
	if (draftText === null) {
		throw new SandboxSetupError(
			'EJECT_SPEC_MISSING',
			`${module.id} changed, but ${specPath} is gone from the session. Restore it before delivering.`,
		);
	}
	const changes = diffSpecs(
		parseModuleSpec(baseText),
		parseModuleSpec(draftText),
	);
	const reasons: string[] = [];
	if (!changes.some((change) => change.field === 'specVersion')) {
		reasons.push(
			`specVersion is unchanged (bump it: patch for a fix, minor for an endpoint, table, column, screen, widget or permission)`,
		);
	}
	if (
		!changes.some(
			(change) =>
				change.field === 'acceptanceScenarios' && change.kind !== 'removed',
		)
	) {
		reasons.push(
			'no acceptance scenario was added or changed (state the new behaviour as given, when, then)',
		);
	}
	if (reasons.length === 0) return;
	throw new SandboxSetupError(
		reasons[0]!.startsWith('specVersion')
			? 'EJECT_SPEC_VERSION_UNCHANGED'
			: 'EJECT_SPEC_SCENARIOS_UNCHANGED',
		`${module.id} changed ${changedFiles} ${
			changedFiles === 1 ? 'file' : 'files'
		}, but ${specPath} does not cover the change: ${reasons.join(
			', and ',
		)}. Ask the business manager for the delta, approve it, then deliver again.`,
	);
}

/* Delivery repeats the turn gate. A plan can be opened hours after a turn, and
   both local eject and the pull-request target use this function, so this is
   the last shared boundary before either target writes or pushes anything. */
async function assertSpecApproved(
	module: SessionModule,
	sourcePath: string,
): Promise<void> {
	const text = await readSpecText(sourcePath);
	const specPath = `modules/${module.directory}/${SPEC_FILE}`;
	if (text === null) {
		throw new SandboxSetupError(
			'EJECT_SPEC_MISSING',
			`${module.id} has no ${specPath} to approve before delivery.`,
		);
	}
	if (!isSpecApproved(module, text)) {
		throw new SandboxSetupError(
			'EJECT_SPEC_NOT_APPROVED',
			`${module.id} has a draft or stale specification. Review and approve the current ${specPath} before delivery.`,
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
		await assertSpecApproved(module, sourcePath);
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
		assertExistingMigrationsUnchanged(
			module,
			changes.overwrites,
			changes.removes,
		);
		const changedFiles =
			changes.additions.length +
			changes.overwrites.length +
			changes.removes.length;
		if (module.kind === 'edit' && changedFiles > 0) {
			await assertSpecCoversChange(
				module,
				sourcePath,
				basePathOf(paths, module.directory),
				changedFiles,
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
