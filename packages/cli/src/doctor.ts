import { agentResource, findBlueprintFiles } from './agent-resources.ts';
import { sdkModules } from './sdk.ts';
import { access, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { syncPlatformModules } from './module-sync.ts';
import { findNamedFiles, validateFile, validators } from './validation.ts';
import type { Workspace } from './workspace.ts';

export interface DoctorCheck {
	readonly id: string;
	readonly status: 'pass' | 'fail' | 'warn';
	readonly message: string;
	readonly evidence?: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function runDoctor(
	workspace: Workspace,
): Promise<readonly DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const major = Number(process.versions.node.split('.')[0]);
	checks.push({
		id: 'runtime.node',
		status: major >= 22 ? 'pass' : 'fail',
		message:
			major >= 22
				? `Node ${process.versions.node}`
				: 'Node 22.22.2 or newer is required.',
		evidence: process.execPath,
	});

	const project = await validateFile(workspace.configPath, validators.project);
	checks.push({
		id: 'contract.project',
		status: project.valid ? 'pass' : 'fail',
		message: project.valid
			? 'Project contract is valid.'
			: project.issues.map((issue) => issue.message).join('; '),
		evidence: relative(workspace.root, workspace.configPath),
	});

	for (const [id, resource] of [
		['policy.capabilities', agentResource(workspace, 'policy')],
		['policy.model-routing', agentResource(workspace, 'modelRouting')],
		['blueprints.root', agentResource(workspace, 'blueprints')],
		['modules.root', join(workspace.root, 'modules')],
		...((await sdkModules(workspace)).size
			? []
			: ([['packages.root', join(workspace.root, 'packages')]] as const)),
		['platform.root', join(workspace.root, 'platform')],
	] as const) {
		const path = relative(workspace.root, resource);
		checks.push({
			id,
			status: (await exists(join(workspace.root, path))) ? 'pass' : 'fail',
			message: (await exists(join(workspace.root, path)))
				? `${path} is present.`
				: `${path} is missing.`,
			evidence: path,
		});
	}

	const packageJson = JSON.parse(
		await readFile(join(workspace.root, 'package.json'), 'utf8'),
	) as {
		packageManager?: string;
	};
	checks.push({
		id: 'workspace.pnpm',
		status: packageJson.packageManager?.startsWith('pnpm@') ? 'pass' : 'fail',
		message: packageJson.packageManager
			? `Pinned package manager: ${packageJson.packageManager}`
			: 'packageManager must pin pnpm.',
		evidence: 'package.json',
	});

	const blueprints = await findBlueprintFiles(workspace);
	checks.push({
		id: 'blueprints.discovered',
		status: blueprints.length > 0 ? 'pass' : 'fail',
		message:
			blueprints.length > 0
				? `${blueprints.length} blueprint(s) discoverable.`
				: 'No blueprint.json was found; "blueprint validate --all" would pass vacuously.',
		evidence: blueprints
			.map((file) => relative(workspace.root, file))
			.join(', '),
	});

	/* Drift is a warning, not a failure: "pnpm dev" and "pnpm build" run the
	   sync themselves, and the build smoke-tests doctor before that sync. */
	try {
		const sync = await syncPlatformModules(workspace, false);
		const stale = sync.files
			.filter((file) => file.changed)
			.map((file) => file.path);
		checks.push({
			id: 'composition.generated',
			status: stale.length === 0 ? 'pass' : 'warn',
			message:
				stale.length === 0
					? `Generated composition matches ${sync.modules.length} enabled module(s).`
					: `Generated composition is stale: ${stale.join(', ')}. Run "pnpm flowdular module sync --apply".`,
			evidence: 'platform/src/generated',
		});
	} catch (error) {
		checks.push({
			id: 'composition.generated',
			status: 'fail',
			message: error instanceof Error ? error.message : String(error),
			evidence: 'flowdular.json',
		});
	}

	return checks;
}
