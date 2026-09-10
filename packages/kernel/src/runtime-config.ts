import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

export class UnsafeLocalStatePathError extends Error {
	readonly code = 'UNSAFE_LOCAL_STATE_PATH';

	constructor(path: string, expected: 'directory' | 'file') {
		super(`Local state path ${path} is not a regular ${expected}.`);
		this.name = 'UnsafeLocalStatePathError';
	}
}

/** FD_ is the public prefix. Existing deployments may still supply CL_ keys. */
export function flowdularEnvironment(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const result = { ...environment };
	for (const [key, value] of Object.entries(environment)) {
		if (key.startsWith('CL_')) {
			const current = `FD_${key.slice(3)}`;
			if (result[current] === undefined) result[current] = value;
		}
	}
	return result;
}

/** Keep a pre-rename database, vault and sandbox in the same physical root. */
export function flowdularStateDirectory(workspaceRoot: string): string {
	const current = resolve(workspaceRoot, '.flowdular');
	const legacy = resolve(workspaceRoot, '.coreloom');
	const exists = (path: string): boolean => {
		try {
			const info = lstatSync(path);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw new UnsafeLocalStatePathError(path, 'directory');
			}
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw error;
		}
	};
	const hasCurrent = exists(current);
	const hasLegacy = exists(legacy);
	if (hasCurrent && hasLegacy) {
		throw new Error(
			'Both .flowdular and .coreloom state directories exist. Stop the application and choose one complete state directory before restarting.',
		);
	}
	return hasLegacy ? legacy : current;
}
