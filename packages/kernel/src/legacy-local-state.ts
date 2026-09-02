import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const CORELOOM_DATA_DIRECTORY = '.coreloom/data';

/* Kept only for the guarded compatibility path and the explicit CLI copy.
   Runtime code must never read from this directory. */
export const LEGACY_DATA_DIRECTORY = '.octane-erp';

export class LegacyLocalStateError extends Error {
	readonly code = 'LEGACY_LOCAL_STATE_REQUIRES_MIGRATION';

	constructor(readonly fileName: string) {
		super(
			`Legacy local state exists for ${fileName}. Stop Coreloom and run "coreloom setup migrate-state" before starting it again.`,
		);
		this.name = 'LegacyLocalStateError';
	}
}

export class UnsafeLocalStatePathError extends Error {
	readonly code = 'UNSAFE_LOCAL_STATE_PATH';

	constructor(path: string, expected: 'directory' | 'file') {
		super(`Local state path ${path} is not a regular ${expected}.`);
		this.name = 'UnsafeLocalStatePathError';
	}
}

function state(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		)
			return undefined;
		throw error;
	}
}

function directory(path: string, create: boolean): void {
	let current = state(path);
	if (!current && create) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if (
				!(
					error instanceof Error &&
					'code' in error &&
					(error as NodeJS.ErrnoException).code === 'EEXIST'
				)
			)
				throw error;
		}
		current = state(path);
	}
	if (current && (current.isSymbolicLink() || !current.isDirectory())) {
		throw new UnsafeLocalStatePathError(path, 'directory');
	}
	if (current && create) chmodSync(path, 0o700);
}

function regularFile(path: string) {
	const current = state(path);
	if (current && (current.isSymbolicLink() || !current.isFile())) {
		throw new UnsafeLocalStatePathError(path, 'file');
	}
	return current;
}

export function coreloomLocalDataPath(
	workspaceRoot: string,
	fileName: string,
): string {
	if (
		fileName.length === 0 ||
		fileName.includes('/') ||
		fileName.includes('\\') ||
		fileName === '.' ||
		fileName === '..'
	) {
		throw new TypeError(
			'A local state file name must be a single path segment.',
		);
	}
	const coreloomDirectory = resolve(workspaceRoot, '.coreloom');
	const dataDirectory = resolve(workspaceRoot, CORELOOM_DATA_DIRECTORY);
	const legacyDirectory = resolve(workspaceRoot, LEGACY_DATA_DIRECTORY);
	const target = resolve(dataDirectory, fileName);
	const legacy = resolve(legacyDirectory, fileName);
	directory(legacyDirectory, false);
	const legacyState = regularFile(legacy);
	directory(coreloomDirectory, false);
	directory(dataDirectory, false);
	const targetState = regularFile(target);
	if (!targetState && legacyState) {
		throw new LegacyLocalStateError(fileName);
	}
	directory(coreloomDirectory, true);
	directory(dataDirectory, true);
	return target;
}
