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

export interface LocalStateRoots {
	/** Where state belongs now, whether or not it exists yet. */
	readonly current: string;
	/** The pre-rename root, when this workspace still has one. */
	readonly legacy: string | null;
	/** True while both exist: no single root can be chosen for the runtime. */
	readonly split: boolean;
}

export const SPLIT_LOCAL_STATE_MESSAGE =
	'Both .flowdular and .coreloom state directories exist. Stop the application and choose one complete state directory before restarting.';

/**
 * Both candidate roots, without choosing between them. Operator tooling that
 * has to report or repair a split workspace reads this; everything that serves
 * a request takes the single root from `flowdularStateDirectory`.
 */
export function localStateRoots(workspaceRoot: string): LocalStateRoots {
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
	return {
		current,
		legacy: hasLegacy ? legacy : null,
		split: hasCurrent && hasLegacy,
	};
}

/** Keep a pre-rename database, vault and sandbox in the same physical root. */
export function flowdularStateDirectory(workspaceRoot: string): string {
	const roots = localStateRoots(workspaceRoot);
	if (roots.split) throw new Error(SPLIT_LOCAL_STATE_MESSAGE);
	return roots.legacy ?? roots.current;
}
