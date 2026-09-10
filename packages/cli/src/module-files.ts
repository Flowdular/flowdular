import { sdkModules } from './sdk.ts';
import { createRequire } from 'node:module';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findNamedFiles } from './validation.ts';
import {
	resolveExistingInside,
	resolveInside,
	type Workspace,
} from './workspace.ts';

export function moduleRoots(workspace: Workspace): string[] {
	const roots = (workspace.config.modules as { roots?: unknown } | undefined)
		?.roots ?? ['modules'];
	if (
		!Array.isArray(roots) ||
		!roots.length ||
		roots.some(
			(root) =>
				typeof root !== 'string' ||
				!root ||
				root.startsWith('.') ||
				root.includes('\\') ||
				root.split('/').some((part: string) => part === '..' || !part),
		)
	)
		throw new Error(
			'Invalid modules.roots. Use relative workspace directories.',
		);
	return roots.map((root) => {
		const path = resolveInside(workspace.root, root);
		if (!relative(workspace.root, path))
			throw new Error('The workspace root cannot be a module root.');
		return path;
	});
}

export async function findModuleFiles(workspace: Workspace): Promise<string[]> {
	const files = new Set<string>();
	for (const root of moduleRoots(workspace)) {
		try {
			await lstat(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		await resolveExistingInside(workspace.root, root);
		for (const file of await findNamedFiles(root, 'module.json')) {
			// Only direct module children are owned modules, never nested fixtures.
			if (relative(root, file).split('/').length === 2) files.add(file);
		}
	}
	// Published baseline modules live in platform dependencies. Local source wins
	// only for the same package, so editable modules remain the source of truth.
	const packages = new Set<string>();
	for (const file of files)
		packages.add(
			(JSON.parse(await readFile(file, 'utf8')) as { package: string }).package,
		);
	for (const file of (await sdkModules(workspace)).keys()) {
		const manifest = JSON.parse(await readFile(file, 'utf8')) as {
			package: string;
		};
		if (!packages.has(manifest.package)) files.add(file);
	}
	const platformPackage = join(workspace.root, 'platform/package.json');
	try {
		const pkg = JSON.parse(await readFile(platformPackage, 'utf8')) as {
			dependencies?: Record<string, string>;
		};
		const require = createRequire(platformPackage);
		for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
			if (!name.startsWith('@flowdular/module-') || packages.has(name))
				continue;
			let file: string;
			try {
				file = require.resolve(name + '/module.json');
			} catch (error) {
				if (
					['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
						(error as NodeJS.ErrnoException).code ?? '',
					)
				)
					continue;
				throw error;
			}
			files.add(file);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return [...files].sort();
}
