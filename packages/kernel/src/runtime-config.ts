import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

export class UnsafeLocalStatePathError extends Error {
	readonly code = 'UNSAFE_LOCAL_STATE_PATH';

	constructor(path: string, expected: 'directory' | 'file') {
		super(`Local state path ${path} is not a regular ${expected}.`);
		this.name = 'UnsafeLocalStatePathError';
	}
}

/** Where local state belongs, whether or not it exists yet. */
export function flowdularStateDirectory(workspaceRoot: string): string {
	const directory = resolve(workspaceRoot, '.flowdular');
	try {
		const info = lstatSync(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new UnsafeLocalStatePathError(directory, 'directory');
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return directory;
}
