import { readFileSync, realpathSync } from 'node:fs';
import {
	createRequire,
	registerHooks,
	stripTypeScriptTypes,
} from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node does not transform TypeScript inside installed packages. Keep the loader
// limited to selected module code and its SDK, including later dynamic imports.
const roots = new Set<string>();
let registered = false;
export async function importModuleSource(
	entry: string,
	moduleRoot: string,
): Promise<unknown> {
	roots.add(realpathSync(moduleRoot));
	try {
		const require = createRequire(pathToFileURL(entry));
		roots.add(
			realpathSync(dirname(require.resolve('@flowdular/sdk/package.json'))),
		);
	} catch (error) {
		if (
			!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			throw error;
	}
	if (!registered) {
		registerHooks({
			load(url, context, nextLoad) {
				if (!url.startsWith('file:') || !fileURLToPath(url).endsWith('.ts'))
					return nextLoad(url, context);
				const path = realpathSync(fileURLToPath(url));
				if (![...roots].some((root) => path.startsWith(root + sep)))
					return nextLoad(url, context);
				return {
					format: 'module',
					source: stripTypeScriptTypes(readFileSync(path, 'utf8'), {
						mode: 'transform',
						sourceUrl: url,
					}),
					shortCircuit: true,
				};
			},
		});
		registered = true;
	}
	return import(pathToFileURL(entry).href);
}
