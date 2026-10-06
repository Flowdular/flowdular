import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/* Where a workspace's module manifests live. The CLI composes the application
   from this list and the running platform reads its module catalog from it,
   so the two agree on which modules exist. Node only: it reads the disk. */

const SDK_INDEX = '@flowdular/sdk/modules.json';
const SDK_IMPORT = /^@flowdular\/sdk\/modules\/[a-z0-9-]+$/;
const SDK_INDEX_LIMIT = 256;
const UNRESOLVED = new Set([
	'MODULE_NOT_FOUND',
	'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);
/* Never module directories of the workspace, whatever their contents. */
const SKIPPED_DIRECTORIES = new Set([
	'.git',
	'.flowdular',
	'.vercel',
	'node_modules',
	'dist',
]);

function errorCode(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? '';
}

function insideRealPath(root: string, path: string, shown = path): string {
	const canonicalRoot = realpathSync(root);
	const canonical = realpathSync(path);
	const fromRoot = relative(canonicalRoot, canonical);
	if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new Error(`Path escapes the workspace through a link: ${shown}`);
	}
	return canonical;
}

function manifestPackage(path: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
			package?: unknown;
		};
		return typeof manifest.package === 'string' ? manifest.package : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The `modules.roots` of flowdular.json as absolute directories, `modules`
 * when unset. Throws for a root that is absolute, starts with a dot, climbs
 * out of the workspace or is the workspace itself.
 */
export function moduleRootDirectories(
	workspaceRoot: string,
	roots?: unknown,
): readonly string[] {
	const configured = roots ?? ['modules'];
	if (
		!Array.isArray(configured) ||
		configured.length === 0 ||
		configured.some(
			(root) =>
				typeof root !== 'string' ||
				!root ||
				root.startsWith('.') ||
				root.includes('\\') ||
				root.split('/').some((part) => part === '..' || !part),
		)
	) {
		throw new Error(
			'Invalid modules.roots. Use relative workspace directories.',
		);
	}
	return (configured as readonly string[]).map((root) => {
		const path = resolve(workspaceRoot, root);
		if (!relative(workspaceRoot, path)) {
			throw new Error('The workspace root cannot be a module root.');
		}
		return path;
	});
}

/**
 * The manifests @flowdular/sdk ships, by real path, with the SDK export each
 * module is imported through. Empty when platform/ cannot resolve the SDK. A
 * deployment resolves the copy infra/sdk-module-manifests.mjs ships.
 */
export function sdkModuleManifests(
	workspaceRoot: string,
): ReadonlyMap<string, string> {
	const require = createRequire(join(workspaceRoot, 'platform/package.json'));
	let indexPath: string;
	try {
		indexPath = require.resolve(SDK_INDEX);
	} catch (error) {
		if (UNRESOLVED.has(errorCode(error))) return new Map();
		throw error;
	}
	const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
		schemaVersion?: unknown;
		modules?: unknown;
	};
	if (
		index.schemaVersion !== 1 ||
		!Array.isArray(index.modules) ||
		index.modules.length > SDK_INDEX_LIMIT
	) {
		throw new Error('Invalid SDK module index.');
	}
	const sdkRoot = dirname(indexPath);
	const result = new Map<string, string>();
	for (const entry of index.modules as {
		manifest?: unknown;
		import?: unknown;
	}[]) {
		if (typeof entry?.import !== 'string' || !SDK_IMPORT.test(entry.import)) {
			throw new Error('Invalid SDK module entrypoint.');
		}
		if (typeof entry.manifest !== 'string') {
			throw new Error('Invalid SDK module manifest path.');
		}
		const lexical = resolve(sdkRoot, entry.manifest);
		const fromRoot = relative(sdkRoot, lexical);
		if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
			throw new Error(`Path escapes the workspace: ${entry.manifest}`);
		}
		const path = insideRealPath(sdkRoot, lexical, entry.manifest);
		if (result.has(path)) throw new Error('Duplicate SDK module path.');
		result.set(path, entry.import);
	}
	return result;
}

/**
 * Every module.json the workspace composes from, sorted by path: the direct
 * children of each module root, the modules @flowdular/sdk ships, and the
 * `@flowdular/module-*` dependencies of platform/package.json. A published
 * module is left out when a local one has the same package, so editable
 * source stays the truth. Throws where the CLI refuses to compose: an
 * invalid root, a root or SDK manifest reached through a link that leaves
 * its tree, or an invalid SDK index.
 */
export function findModuleManifests(
	workspaceRoot: string,
	roots?: unknown,
): readonly string[] {
	const files = new Set<string>();
	for (const root of moduleRootDirectories(workspaceRoot, roots)) {
		try {
			lstatSync(root);
		} catch (error) {
			if (errorCode(error) === 'ENOENT') continue;
			throw error;
		}
		insideRealPath(workspaceRoot, root);
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = join(root, entry.name, 'module.json');
			try {
				if (!lstatSync(path).isDirectory()) files.add(path);
			} catch (error) {
				if (errorCode(error) !== 'ENOENT') throw error;
			}
		}
	}
	const packages = new Set<string>();
	for (const file of files) {
		const name = manifestPackage(file);
		if (name) packages.add(name);
	}
	for (const file of sdkModuleManifests(workspaceRoot).keys()) {
		const name = manifestPackage(file);
		if (!name || !packages.has(name)) files.add(file);
	}
	const platformPackage = join(workspaceRoot, 'platform/package.json');
	let dependencies: Record<string, string> = {};
	try {
		dependencies =
			(
				JSON.parse(readFileSync(platformPackage, 'utf8')) as {
					dependencies?: Record<string, string>;
				}
			).dependencies ?? {};
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error;
	}
	const require = createRequire(platformPackage);
	for (const name of Object.keys(dependencies).sort()) {
		if (!name.startsWith('@flowdular/module-') || packages.has(name)) continue;
		try {
			files.add(require.resolve(`${name}/module.json`));
		} catch (error) {
			if (!UNRESOLVED.has(errorCode(error))) throw error;
		}
	}
	return [...files].sort();
}
