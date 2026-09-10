import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Workspace } from './workspace.ts';
import { resolveExistingInside } from './workspace.ts';

export const SDK_VERSION = '0.2.1';
const LIBRARIES = new Set([
	'ai-provider',
	'cli-protocol',
	'client',
	'contracts',
	'database',
	'database-pglite',
	'database-testing',
	'dev-console',
	'harness',
	'kernel',
	'server',
	'ui',
]);
const CORE_MODULES = new Set([
	'agents',
	'auth',
	'automations',
	'automations-workflows-integration',
	'profile',
	'sandbox',
	'system',
	'users',
	'workflows',
]);
export function sdkSpecifier(name: string): string {
	const suffix = name.slice('@flowdular/'.length);
	if (!name.startsWith('@flowdular/')) return name;
	if (LIBRARIES.has(suffix)) return `@flowdular/sdk/${suffix}`;
	if (suffix.startsWith('module-') && CORE_MODULES.has(suffix.slice(7)))
		return `@flowdular/sdk/modules/${suffix.slice(7)}`;
	return name;
}
export function sdkSource(source: string): string {
	return source.replace(/@flowdular\/[a-z0-9-]+/g, sdkSpecifier);
}
export function npmPackage(specifier: string): string {
	return specifier.startsWith('@')
		? specifier.split('/').slice(0, 2).join('/')
		: specifier.split('/')[0]!;
}
export async function sdkModules(
	workspace: Workspace,
): Promise<ReadonlyMap<string, string>> {
	const require = createRequire(join(workspace.root, 'platform/package.json'));
	let indexPath: string;
	try {
		indexPath = require.resolve('@flowdular/sdk/modules.json');
	} catch (error) {
		if (
			['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
				(error as NodeJS.ErrnoException).code ?? '',
			)
		)
			return new Map();
		throw error;
	}
	const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
		schemaVersion: number;
		modules: { manifest: string; import: string }[];
	};
	if (
		index.schemaVersion !== 1 ||
		!Array.isArray(index.modules) ||
		index.modules.length > 256
	)
		throw new Error('Invalid SDK module index.');
	const result = new Map<string, string>();
	for (const entry of index.modules) {
		if (!/^@flowdular\/sdk\/modules\/[a-z0-9-]+$/.test(entry.import))
			throw new Error('Invalid SDK module entrypoint.');
		const path = await resolveExistingInside(
			dirname(indexPath),
			entry.manifest,
		);
		if (result.has(path)) throw new Error('Duplicate SDK module path.');
		result.set(path, entry.import);
	}
	return result;
}
export function sdkScaffold(
	files: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	return new Map(
		[...files].map(([path, source]) => {
			if (path === 'spec/module.yaml' || path === 'module.json')
				return [path, source];
			if (path !== 'package.json') return [path, sdkSource(source)];
			const pkg = JSON.parse(source) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			for (const section of [pkg.dependencies, pkg.devDependencies])
				if (section)
					for (const name of Object.keys(section))
						if (sdkSpecifier(name) !== name) delete section[name];
			pkg.dependencies ??= {};
			pkg.dependencies['@flowdular/sdk'] = SDK_VERSION;
			return [path, JSON.stringify(pkg, null, '\t') + '\n'];
		}),
	);
}
