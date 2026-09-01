import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface Workspace {
	readonly root: string;
	readonly configPath: string;
	readonly config: Record<string, unknown>;
}

export async function findWorkspace(start: string): Promise<Workspace> {
	let directory = resolve(start);
	for (;;) {
		const configPath = resolve(directory, 'coreloom.json');
		try {
			await access(configPath);
			const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<
				string,
				unknown
			>;
			return { root: directory, configPath, config };
		} catch (error) {
			if (error instanceof SyntaxError) throw error;
		}

		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error(
				'No coreloom.json was found in this directory or any parent.',
			);
		}
		directory = parent;
	}
}

export function resolveInside(root: string, candidate: string): string {
	const absolute = isAbsolute(candidate)
		? resolve(candidate)
		: resolve(root, candidate);
	const pathFromRoot = relative(root, absolute);
	if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
		throw new Error(`Path escapes the workspace: ${candidate}`);
	}
	return absolute;
}

export async function resolveExistingInside(
	root: string,
	candidate: string,
): Promise<string> {
	const canonicalRoot = await realpath(root);
	const canonicalCandidate = await realpath(resolveInside(root, candidate));
	const pathFromRoot = relative(canonicalRoot, canonicalCandidate);
	if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
		throw new Error(`Path escapes the workspace through a link: ${candidate}`);
	}
	return canonicalCandidate;
}
