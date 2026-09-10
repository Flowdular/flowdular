import { createRequire } from 'node:module';
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { SandboxSetupError } from './workspace-root.ts';

const EXCLUDED = new Set([
	'node_modules',
	'dist',
	'.git',
	'.flowdular',
	'.turbo',
]);

/* Published SDK contents are immutable. Cache a real copy per session and SDK
   installation, outside the module graph. Never widen agent filesystem access. */
export async function materializeSdkReference(
	workspaceRoot: string,
	sessionWorkspace: string,
): Promise<boolean> {
	let source: string;
	try {
		const require = createRequire(join(workspaceRoot, 'platform/package.json'));
		source = await realpath(
			dirname(require.resolve('@flowdular/sdk/package.json')),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND')
			return false;
		throw error;
	}
	const manifest = await readFile(join(source, 'package.json'), 'utf8');
	const reference = join(sessionWorkspace, 'reference');
	const info = await lstat(reference).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (info && !info.isDirectory())
		throw new SandboxSetupError(
			'SDK_REFERENCE_INVALID',
			'The session reference directory is not a regular directory.',
		);
	await mkdir(reference, { recursive: true });
	const target = join(reference, 'sdk');
	// Metadata belongs to the host, outside the agent workspace and its guard.
	const marker = join(dirname(sessionWorkspace), 'sdk-reference.json');
	const identity = JSON.stringify({ source, manifest });
	try {
		if (
			(await lstat(target)).isDirectory() &&
			(await lstat(join(target, 'package.json'))).isFile() &&
			(await readFile(marker, 'utf8')) === identity &&
			(await readFile(join(target, 'package.json'), 'utf8')) === manifest
		)
			return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const staging = await mkdtemp(
		join(dirname(sessionWorkspace), 'sdk-reference-'),
	);
	try {
		await writeFile(join(staging, 'package.json'), manifest);
		for (const member of ['packages', 'modules', 'modules.json']) {
			const from = join(source, member);
			try {
				await lstat(from);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			await cp(from, join(staging, member), {
				recursive: true,
				filter: async (path) => {
					const parts = relative(source, path).split('/');
					if (parts.some((part) => EXCLUDED.has(part) || part.startsWith('.')))
						return false;
					// A dependency symlink must never survive inside the snapshot.
					return !(await lstat(path)).isSymbolicLink();
				},
			});
		}
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
		await writeFile(marker, identity);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
	return true;
}
