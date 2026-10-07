import { sdkModuleManifests } from '@flowdular/kernel/module-manifests';
import type { Workspace } from './workspace.ts';

export const SDK_VERSION = '0.6.3';
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
	'storage',
	'ui',
]);
const CORE_MODULES = new Set([
	'agents',
	'auth',
	'automations',
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
	return sdkModuleManifests(workspace.root);
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
