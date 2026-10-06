import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	findModuleManifests,
	sdkModuleManifests,
} from '../src/module-manifests.ts';

const roots: string[] = [];

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-manifests-'));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function write(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function manifest(root: string, directory: string, packageName: string) {
	write(join(root, directory, 'module.json'), {
		id: `${packageName.split('-').pop()}.core`,
		package: packageName,
	});
}

/* platform/ depends on @flowdular/sdk, which ships the listed module
   directories and indexes them in modules.json. */
function installSdk(
	root: string,
	directories: readonly string[],
	index: unknown = undefined,
): string {
	const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
	write(join(root, 'platform/package.json'), {
		dependencies: { '@flowdular/sdk': '0.6.0' },
	});
	write(join(sdk, 'package.json'), {
		name: '@flowdular/sdk',
		exports: { './modules.json': './modules.json' },
	});
	for (const directory of directories) {
		manifest(sdk, `modules/${directory}`, `@flowdular/module-${directory}`);
	}
	write(
		join(sdk, 'modules.json'),
		index ?? {
			schemaVersion: 1,
			modules: directories.map((directory) => ({
				manifest: `modules/${directory}/module.json`,
				import: `@flowdular/sdk/modules/${directory}`,
			})),
		},
	);
	return sdk;
}

describe('module manifests', () => {
	it('finds the workspace modules alone when no SDK is installed, as in a deployed image', () => {
		const root = workspace();
		manifest(root, 'modules/billing', '@app/module-billing');
		manifest(root, 'modules/billing/fixtures/nested', '@app/module-nested');
		manifest(root, 'modules/node_modules', '@app/module-installed');
		mkdirSync(join(root, 'modules/empty'));

		expect(findModuleManifests(root)).toEqual([
			join(root, 'modules/billing/module.json'),
		]);
		expect(sdkModuleManifests(root).size).toBe(0);
	});

	it('adds the modules @flowdular/sdk ships, and a local module of the same package wins', () => {
		const root = workspace();
		manifest(root, 'modules/billing', '@app/module-billing');
		manifest(root, 'modules/search', '@flowdular/module-search');
		installSdk(root, ['search', 'approvals']);
		const shipped = (directory: string) =>
			join('@flowdular/sdk/modules', directory, 'module.json');

		const found = findModuleManifests(root);

		expect(found).toHaveLength(3);
		expect(found).toContain(join(root, 'modules/billing/module.json'));
		expect(found).toContain(join(root, 'modules/search/module.json'));
		expect(found.some((path) => path.endsWith(shipped('approvals')))).toBe(
			true,
		);
		expect(found.some((path) => path.endsWith(shipped('search')))).toBe(false);
		expect(found).toEqual([...found].sort());
		expect([...sdkModuleManifests(root).values()].sort()).toEqual([
			'@flowdular/sdk/modules/approvals',
			'@flowdular/sdk/modules/search',
		]);
	});

	it('honours the configured module roots', () => {
		const root = workspace();
		manifest(root, 'modules/billing', '@app/module-billing');
		manifest(root, 'apps/crm', '@app/module-crm');

		expect(findModuleManifests(root, ['apps'])).toEqual([
			join(root, 'apps/crm/module.json'),
		]);
		expect(() => findModuleManifests(root, ['../outside'])).toThrow(
			/Invalid modules.roots/,
		);
	});

	it('refuses a module root or an SDK manifest that a link takes out of its tree', () => {
		const root = workspace();
		const outside = workspace();
		manifest(outside, 'billing', '@app/module-billing');
		symlinkSync(outside, join(root, 'modules'));
		expect(() => findModuleManifests(root)).toThrow(/escapes the workspace/);

		const other = workspace();
		const sdk = installSdk(other, [], {
			schemaVersion: 1,
			modules: [
				{
					manifest: 'modules/linked/module.json',
					import: '@flowdular/sdk/modules/linked',
				},
			],
		});
		mkdirSync(join(sdk, 'modules'), { recursive: true });
		symlinkSync(join(outside, 'billing'), join(sdk, 'modules/linked'));
		expect(() => sdkModuleManifests(other)).toThrow(
			/escapes the workspace through a link: modules\/linked\/module.json/,
		);
	});
});
