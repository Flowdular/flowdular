import { spawnSync } from 'node:child_process';
import { type PackageManager } from './args.ts';

/* The default template uses pnpm workspaces and workspace: dependencies.
   npm create is the launcher, not the package manager of the generated app. */
export function detectPackageManager(
	_userAgent: string | undefined,
): PackageManager {
	return 'pnpm';
}

export interface InstallResult {
	readonly ok: boolean;
	readonly reason?: string;
}

export function installDependencies(
	packageManager: PackageManager,
	directory: string,
): InstallResult {
	let result = spawnSync(packageManager, ['install'], {
		cwd: directory,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	});
	if (
		packageManager === 'pnpm' &&
		(result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
	) {
		result = spawnSync(
			'npm',
			['exec', '--yes', '--package=pnpm@11.17.0', '--', 'pnpm', 'install'],
			{
				cwd: directory,
				stdio: 'inherit',
				shell: process.platform === 'win32',
			},
		);
	}
	if (result.error) {
		return { ok: false, reason: `${packageManager} could not be started` };
	}
	if (result.status !== 0) {
		return {
			ok: false,
			reason: `${packageManager} install exited with code ${String(result.status)}`,
		};
	}
	return { ok: true };
}
