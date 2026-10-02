import { readFileSync, realpathSync } from 'node:fs';
import {
	createRequire,
	registerHooks,
	stripTypeScriptTypes,
} from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// SDK server entrypoints are source TypeScript. Node deliberately does not strip
// types in node_modules, even with --experimental-transform-types. Transform only
// this application's and its SDK's source; never install a global package loader.
const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const roots = [packageRoot];
try {
	const require = createRequire(import.meta.url);
	roots.push(
		realpathSync(dirname(require.resolve('@flowdular/sdk/package.json'))),
	);
} catch (error) {
	if (
		error.code !== 'MODULE_NOT_FOUND' &&
		error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
		error.code !== 'ERR_ACCESS_DENIED'
	)
		throw error;
	// The authoring workspace uses ordinary, linked source packages. A denial
	// means the walk left the roots this worker may read, which answers the
	// same question: there is no consumer SDK to transform.
}
// The host resolves the consumer's SDK before applying worker permissions. This
// avoids granting the worker access to platform/package.json or following its
// dependency links outside the permitted physical package roots.
if (process.env.FD_INTERNAL_SANDBOX_SDK_ROOT)
	roots.push(realpathSync(process.env.FD_INTERNAL_SANDBOX_SDK_ROOT));

/* The launcher imports source packages from the platform checkout. Resolve
   only declared Flowdular dependencies, including their transitive packages;
   installed packages may sit in a pnpm store rather than this package's own
   node_modules directory. The restricted preview worker has its own roots. */
if (!process.env.FD_INTERNAL_SANDBOX_PREVIEW_WORKER) {
	const known = new Set(roots);
	const pending = [packageRoot];
	while (pending.length > 0) {
		const root = pending.pop();
		const manifest = JSON.parse(
			readFileSync(join(root, 'package.json'), 'utf8'),
		);
		for (const name of Object.keys(manifest.dependencies ?? {})) {
			if (!name.startsWith('@flowdular/')) continue;
			let parent = root;
			for (;;) {
				let dependencyRoot;
				try {
					dependencyRoot = realpathSync(join(parent, 'node_modules', name));
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				if (dependencyRoot) {
					if (!known.has(dependencyRoot)) {
						known.add(dependencyRoot);
						roots.push(dependencyRoot);
						pending.push(dependencyRoot);
					}
					break;
				}
				const next = dirname(parent);
				if (next === parent) break;
				parent = next;
			}
		}
	}
}

registerHooks({
	load(url, context, nextLoad) {
		if (!url.startsWith('file:')) return nextLoad(url, context);
		const path = realpathSync(resolve(fileURLToPath(url)));
		if (
			!path.endsWith('.ts') ||
			!roots.some((root) => path.startsWith(root + sep))
		) {
			return nextLoad(url, context);
		}
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
