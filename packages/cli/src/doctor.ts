import { localStateRoots } from '@flowdular/kernel/runtime-config';
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

	/* A split state root stops the application at startup, so it has to be a
	   check an operator can read rather than the first raw throw of the day. */
	const roots = localStateRoots(workspace.root);
	checks.push({
		id: 'state.root',
		status: roots.split ? 'fail' : 'pass',
		message: roots.split
			? 'Both .flowdular and .coreloom state directories exist. Keep the one holding the state you want, remove the other, and run "flowdular setup migrate-state" if a .octane-erp directory is also present.'
			: `Local state root: ${relative(workspace.root, roots.legacy ?? roots.current)}`,
		evidence: relative(workspace.root, roots.legacy ?? roots.current),
	});

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

	/* An application scaffolded before the branding release renders none of it,
	   and one upgraded halfway keeps the static icon and theme colour that now
	   compete with the rendered ones, which is a head with two answers. Both
	   are warnings: the application serves either way, and the fix is in files
	   the operator owns. */
	const entryPath = join(workspace.root, 'platform/src/App.tsrx');
	if (await exists(entryPath)) {
		const entry = await readFile(entryPath, 'utf8');
		const pagePath = join(workspace.root, 'platform/index.html');
		const page = (await exists(pagePath))
			? await readFile(pagePath, 'utf8')
			: '';
		const renders = entry.includes('configureBrandingFromPage');
		const staticHead = /<meta[^>]+name="theme-color"|<link[^>]+rel="icon"/.test(
			page,
		);
		checks.push({
			id: 'platform.branding',
			status: renders && !staticHead ? 'pass' : 'warn',
			message: !renders
				? 'The application entry does not render the deployment branding. Add configureBrandingFromPage(props) and the head tags the scaffold template carries, so the name, title, icon and link preview follow the settings.'
				: staticHead
					? 'platform/index.html declares its own icon or theme colour while the entry renders them too, so the head carries two answers. Remove the static tags.'
					: 'The application entry renders the deployment branding.',
			evidence: 'platform/src/App.tsrx',
		});
	}

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
