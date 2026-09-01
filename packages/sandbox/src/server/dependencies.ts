import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';

const SOURCE = /\.(ts|tsx|tsrx|mts|cts)$/;
const IMPORT =
	/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'tests']);

export interface DependencyReport {
	readonly declared: readonly string[];
	readonly imported: readonly string[];
	readonly missing: readonly string[];
}

function packageOf(specifier: string): string | null {
	if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
	if (isBuiltin(specifier)) return null;
	const parts = specifier.split('/');
	return specifier.startsWith('@')
		? `${parts[0]}/${parts[1] ?? ''}`
		: (parts[0] ?? null);
}

async function collectImports(
	directory: string,
	found: Set<string>,
): Promise<void> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (IGNORED_DIRECTORIES.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await collectImports(path, found);
			continue;
		}
		if (!SOURCE.test(entry.name)) continue;
		const source = await readFile(path, 'utf8');
		IMPORT.lastIndex = 0;
		for (;;) {
			const match = IMPORT.exec(source);
			if (!match) break;
			const name = packageOf(match[1] ?? match[2] ?? '');
			if (name) found.add(name);
		}
	}
}

/* A module that imports a package it does not declare typechecks inside the
   sandbox, because the session borrows a sibling module's dependency tree, and
   then fails the moment it is ejected. The gate compares what the sources
   import with what the manifest promises. */
export async function checkDeclaredDependencies(
	modulePath: string,
): Promise<DependencyReport> {
	const imported = new Set<string>();
	await collectImports(join(modulePath, 'src'), imported);

	let declared: readonly string[] = [];
	try {
		const manifest = JSON.parse(
			await readFile(join(modulePath, 'package.json'), 'utf8'),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		declared = [
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		];
	} catch {
		declared = [];
	}

	const known = new Set(declared);
	return {
		declared: [...known].sort(),
		imported: [...imported].sort(),
		missing: [...imported].filter((name) => !known.has(name)).sort(),
	};
}
