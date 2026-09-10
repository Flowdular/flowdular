import { readFileSync, realpathSync } from 'node:fs';
import {
	createRequire,
	registerHooks,
	stripTypeScriptTypes,
} from 'node:module';
import { dirname, resolve, sep } from 'node:path';
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
		error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
	)
		throw error;
	// The authoring workspace uses ordinary, linked source packages.
}
// The host resolves the consumer's SDK before applying worker permissions. This
// avoids granting the worker access to platform/package.json or following its
// dependency links outside the permitted physical package roots.
if (process.env.FD_INTERNAL_SANDBOX_SDK_ROOT)
	roots.push(realpathSync(process.env.FD_INTERNAL_SANDBOX_SDK_ROOT));

registerHooks({
	load(url, context, nextLoad) {
		if (!url.startsWith('file:')) return nextLoad(url, context);
		const path = resolve(fileURLToPath(url));
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
