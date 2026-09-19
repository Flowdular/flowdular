import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SDK_VERSION, sdkScaffold, sdkSource } from '../src/sdk.ts';

/* What the SDK actually publishes. The packing script rewrites specifiers from
   this file, and the scaffold rewrites them from its own lists, so the two have
   to agree or a scaffolded module names a package npm cannot resolve. */
const members = JSON.parse(
	readFileSync(
		new URL('../../../scripts/sdk-members.json', import.meta.url),
		'utf8',
	),
) as Record<string, { directory: string; export: string }>;

/* Modules the SDK carries but a scaffolded module reaches as its own installed
   package, through "flowdular module install". A specifier for one of these
   stays as it is written. */
const INSTALLED_SEPARATELY = new Set([
	'access',
	'adapters',
	'approvals',
	'audit',
	'connectors',
	'directory',
	'documents',
	'exports',
	'import',
	'metering',
	'notifications',
	'reports',
	'research',
	'search',
]);

it('keeps the standalone sandbox distinct from the SDK sandbox access module', () => {
	expect(sdkSource("import '@flowdular/sandbox/server';")).toBe(
		"import '@flowdular/sandbox/server';",
	);
	expect(sdkSource("import '@flowdular/module-sandbox/server';")).toBe(
		"import '@flowdular/sdk/modules/sandbox/server';",
	);
});

it('preserves the approved specification and module identity byte for byte while adapting generated imports', () => {
	const specification =
		'id: example.core\nrequirements:\n  - Follow the @flowdular/contracts contract exactly.\n';
	const manifest = JSON.stringify({
		id: 'example.core',
		package: '@flowdular/module-example',
	});
	const files = sdkScaffold(
		new Map([
			['spec/module.yaml', specification],
			['module.json', manifest],
			[
				'src/index.ts',
				"import type {ModuleManifest} from '@flowdular/contracts';",
			],
			[
				'package.json',
				JSON.stringify({
					name: '@flowdular/module-example',
					dependencies: {
						'@flowdular/contracts': 'workspace:*',
						octane: '0.1.51',
					},
					devDependencies: {
						'@flowdular/database-testing': 'workspace:*',
						vitest: '4.1.11',
					},
				}),
			],
		]),
	);
	expect(files.get('spec/module.yaml')).toBe(specification);
	expect(files.get('module.json')).toBe(manifest);
	expect(files.get('src/index.ts')).toContain(
		"from '@flowdular/sdk/contracts'",
	);
	expect(JSON.parse(files.get('package.json')!)).toEqual({
		name: '@flowdular/module-example',
		dependencies: { octane: '0.1.51', '@flowdular/sdk': SDK_VERSION },
		devDependencies: { vitest: '4.1.11' },
	});
});

it('pins the same SDK version the workspace publishes', async () => {
	const { readFile } = await import('node:fs/promises');
	const sdk = JSON.parse(
		await readFile(new URL('../../sdk/package.json', import.meta.url), 'utf8'),
	) as { version: string };
	expect(SDK_VERSION).toBe(sdk.version);
});

it('translates every library the SDK publishes', () => {
	const libraries = Object.keys(members).filter(
		(name) => !name.startsWith('@flowdular/module-'),
	);
	const untranslated = libraries.filter(
		(name) => sdkSource(`from '${name}'`) === `from '${name}'`,
	);
	expect(untranslated).toEqual([]);
});

it('translates every core module, and leaves the separately installed ones alone', () => {
	for (const name of Object.keys(members)) {
		if (!name.startsWith('@flowdular/module-')) continue;
		const id = name.slice('@flowdular/module-'.length);
		const translated = sdkSource(`from '${name}/server'`);
		if (INSTALLED_SEPARATELY.has(id)) {
			expect(translated).toBe(`from '${name}/server'`);
			continue;
		}
		expect(translated).toBe(`from '@flowdular/sdk/modules/${id}/server'`);
	}
});

it('names no module the SDK does not carry as separately installed', () => {
	const carried = new Set(
		Object.keys(members)
			.filter((name) => name.startsWith('@flowdular/module-'))
			.map((name) => name.slice('@flowdular/module-'.length)),
	);
	expect([...INSTALLED_SEPARATELY].filter((id) => !carried.has(id))).toEqual(
		[],
	);
});
