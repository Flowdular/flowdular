import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Prettier from 'prettier';

export interface Formatter {
	format(path: string, source: string): Promise<string>;
}

/* The workspace format gate runs on tabs, single quotes, and trailing commas.
   These stand in only when a workspace carries no Prettier configuration. */
const DEFAULT_OPTIONS: Prettier.Options = {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'all',
};

const TSRX_PLUGIN = '@tsrx/prettier-plugin';

function resolveFrom(workspaceRoot: string, specifier: string): string {
	for (const base of [join(workspaceRoot, 'package.json'), import.meta.url]) {
		try {
			return createRequire(base).resolve(specifier);
		} catch {
			/* Try the next base. */
		}
	}
	throw new Error(`Cannot resolve ${specifier} from ${workspaceRoot}.`);
}

/* Both packages ship CommonJS entries, whose exports land on `default`. */
async function importModule<T>(path: string): Promise<T> {
	const imported = (await import(pathToFileURL(path).href)) as {
		default?: T;
	};
	return imported.default ?? (imported as T);
}

/* Prettier and the TSRX plugin come from the workspace being scaffolded, or
   from this CLI's own tree when the workspace has none. Returns null when
   neither has them, so callers can warn instead of fail. */
export async function loadWorkspaceFormatter(
	workspaceRoot: string,
): Promise<Formatter | null> {
	let prettier: typeof Prettier;
	let plugins: Prettier.Plugin[];
	try {
		prettier = await importModule<typeof Prettier>(
			resolveFrom(workspaceRoot, 'prettier'),
		);
		plugins = [
			await importModule<Prettier.Plugin>(
				resolveFrom(workspaceRoot, TSRX_PLUGIN),
			),
		];
	} catch {
		return null;
	}
	const configured = await prettier.resolveConfig(
		join(workspaceRoot, 'package.json'),
		{ editorconfig: false },
	);
	const { plugins: _ignored, ...options } = configured ?? DEFAULT_OPTIONS;
	return {
		async format(path, source) {
			const info = await prettier.getFileInfo(path, { plugins });
			if (!info.inferredParser) return source;
			return prettier.format(source, { ...options, plugins, filepath: path });
		},
	};
}
