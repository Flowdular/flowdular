import {
	cp,
	lstat,
	mkdir,
	readFile,
	realpath,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/* A deployment ships no node_modules, yet the platform lists the modules
   @flowdular/sdk ships by resolving the SDK's module index from platform/. This
   copies what that lookup reads (the index, each indexed module.json and its
   spec/module.yaml, and a package.json exporting the index) to the same place
   under the deployment root. A workspace without the SDK copies nothing.

   Usage: node infra/sdk-module-manifests.mjs <workspace> <deployment root> */

/* The platform refuses a larger index, so the copy does too. */
const INDEX_LIMIT = 256;
const UNRESOLVED = new Set([
	'MODULE_NOT_FOUND',
	'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

const [workspaceArgument, deploymentArgument] = process.argv.slice(2);
if (!workspaceArgument || !deploymentArgument) {
	throw new Error(
		'Usage: node infra/sdk-module-manifests.mjs <workspace> <deployment root>',
	);
}
const workspace = resolve(workspaceArgument);
const destination = join(
	resolve(deploymentArgument),
	'platform/node_modules/@flowdular/sdk',
);

function sdkIndexPath() {
	try {
		return createRequire(join(workspace, 'platform/package.json')).resolve(
			'@flowdular/sdk/modules.json',
		);
	} catch (error) {
		if (UNRESOLVED.has(error.code)) return null;
		throw error;
	}
}

function insidePath(root, path) {
	const fromRoot = relative(root, path);
	return (
		Boolean(fromRoot) && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
	);
}

/* Copies a file the index names, refusing one that leaves the SDK lexically or
   through a link. An absent optional file is skipped. */
async function copyFromSdk(sdkRoot, path, optional = false) {
	const lexical = resolve(sdkRoot, path);
	if (!insidePath(sdkRoot, lexical)) {
		throw new Error(`SDK module file escapes the package: ${path}`);
	}
	let source;
	try {
		source = await realpath(lexical);
	} catch (error) {
		if (optional && error.code === 'ENOENT') return;
		throw error;
	}
	if (!insidePath(sdkRoot, source) || !(await lstat(source)).isFile()) {
		throw new Error(
			`SDK module file must be a regular file inside the package: ${path}`,
		);
	}
	const target = join(destination, relative(sdkRoot, lexical));
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target);
}

const indexPath = sdkIndexPath();
if (indexPath) {
	const sdkRoot = await realpath(dirname(indexPath));
	const indexSource = await readFile(indexPath, 'utf8');
	const index = JSON.parse(indexSource);
	if (
		index.schemaVersion !== 1 ||
		!Array.isArray(index.modules) ||
		index.modules.length > INDEX_LIMIT
	) {
		throw new Error('Invalid SDK module index.');
	}
	await mkdir(destination, { recursive: true });
	for (const entry of index.modules) {
		if (typeof entry?.manifest !== 'string') {
			throw new Error('Invalid SDK module manifest path.');
		}
		await copyFromSdk(sdkRoot, entry.manifest);
		await copyFromSdk(
			sdkRoot,
			join(dirname(entry.manifest), 'spec/module.yaml'),
			true,
		);
	}
	await writeFile(join(destination, 'modules.json'), indexSource);
	await writeFile(
		join(destination, 'package.json'),
		`${JSON.stringify(
			{
				name: '@flowdular/sdk',
				private: true,
				exports: { './modules.json': './modules.json' },
			},
			null,
			'\t',
		)}\n`,
	);
}
