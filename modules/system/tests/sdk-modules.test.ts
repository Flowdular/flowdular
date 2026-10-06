import { createPgliteTestProvider } from '@flowdular/database-testing';
import { createPlatformCapabilityRegistry } from '@flowdular/kernel';
import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_MODULES_CAPABILITY } from '../src/domain/modules.ts';
import { createServerComposition } from '../src/platform.ts';
import type { SystemModulesCapability } from '../src/server/capability.ts';
import { readModuleCatalog } from '../src/server/module-catalog.ts';

interface FixtureModule {
	readonly id: string;
	readonly name: string;
	readonly dependencies?: readonly string[];
	readonly provides?: readonly string[];
	readonly requires?: readonly string[];
}

/* The platform modules of a published install ship inside @flowdular/sdk;
   research.core ships but is not enabled. */
const SDK_MODULES: readonly FixtureModule[] = [
	{ id: 'system.core', name: 'System' },
	{ id: 'auth.core', name: 'Authentication' },
	{ id: 'import.core', name: 'Import', provides: ['import.ports.v1'] },
	{ id: 'exports.core', name: 'Exports', requires: ['import.ports.v1'] },
	{ id: 'approvals.core', name: 'Approvals' },
	{ id: 'research.core', name: 'Research' },
];

const APP_MODULE: FixtureModule = {
	id: 'example.core',
	name: 'Example',
	dependencies: ['exports.core'],
};

const ENABLED = [
	'system.core',
	'auth.core',
	'import.core',
	'exports.core',
	'approvals.core',
	'example.core',
];

const directoryOf = (id: string) => id.split('.')[0]!;

function writeModule(
	directory: string,
	module: FixtureModule,
	packageName: string,
): void {
	mkdirSync(join(directory, 'spec'), { recursive: true });
	writeFileSync(
		join(directory, 'module.json'),
		JSON.stringify({
			id: module.id,
			package: packageName,
			version: '1.2.3',
			capabilities: ['api'],
			platform: { server: true, client: true },
			dependencies: (module.dependencies ?? []).map((id) => ({
				id,
				range: '^1.0.0',
			})),
			provides: module.provides ?? [],
			requires: (module.requires ?? []).map((id) => ({ id })),
		}),
	);
	writeFileSync(
		join(directory, 'spec/module.yaml'),
		[`id: ${module.id}`, 'specVersion: 1.2.3', `name: ${module.name}`].join(
			'\n',
		),
	);
}

/* The layout `npm create flowdular` produces: the application's own module in
   modules/, and @flowdular/sdk installed for platform/ with the modules.json
   index the CLI composes SDK modules from. */
function publishedWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-system-sdk-'));
	writeFileSync(
		join(root, 'flowdular.json'),
		JSON.stringify({
			modules: { roots: ['modules'], enabled: ENABLED },
			locales: ['en'],
		}),
	);
	mkdirSync(join(root, 'platform'), { recursive: true });
	writeFileSync(
		join(root, 'platform/package.json'),
		JSON.stringify({ dependencies: { '@flowdular/sdk': '0.6.0' } }),
	);
	const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
	mkdirSync(sdk, { recursive: true });
	writeFileSync(
		join(sdk, 'package.json'),
		JSON.stringify({
			name: '@flowdular/sdk',
			version: '0.6.0',
			exports: { './modules.json': './modules.json' },
		}),
	);
	writeFileSync(
		join(sdk, 'modules.json'),
		JSON.stringify({
			schemaVersion: 1,
			modules: SDK_MODULES.map((module) => ({
				manifest: `modules/${directoryOf(module.id)}/module.json`,
				import: `@flowdular/sdk/modules/${directoryOf(module.id)}`,
			})),
		}),
	);
	for (const module of SDK_MODULES) {
		writeModule(
			join(sdk, 'modules', directoryOf(module.id)),
			module,
			`@flowdular/module-${directoryOf(module.id)}`,
		);
	}
	writeModule(
		join(root, 'modules', directoryOf(APP_MODULE.id)),
		APP_MODULE,
		'@app/module-example',
	);
	return root;
}

describe('a published install whose platform modules ship in @flowdular/sdk', () => {
	let root: string;

	beforeAll(() => {
		root = publishedWorkspace();
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('SYSTEM-MODULES-LIST: lists the SDK modules beside the workspace module, with their specs', () => {
		const catalog = readModuleCatalog(root);

		expect(
			Object.fromEntries(catalog.map((entry) => [entry.id, entry.enabled])),
		).toEqual({
			'system.core': true,
			'auth.core': true,
			'import.core': true,
			'exports.core': true,
			'approvals.core': true,
			'research.core': false,
			'example.core': true,
		});
		expect(catalog.find((entry) => entry.id === 'exports.core')).toMatchObject({
			name: 'Exports',
			version: '1.2.3',
			specVersion: '1.2.3',
			directory: 'exports',
			requires: ['import.ports.v1'],
		});
		expect(catalog.find((entry) => entry.id === 'example.core')).toMatchObject({
			name: 'Example',
			directory: 'example',
			dependencies: ['exports.core'],
		});
	});

	it('SYSTEM-MODULES-LIST: shows a spec edited between two reads', () => {
		const workspace = publishedWorkspace();
		try {
			expect(
				readModuleCatalog(workspace).find((entry) => entry.id === 'import.core')
					?.name,
			).toBe('Import');
			writeFileSync(
				join(
					workspace,
					'platform/node_modules/@flowdular/sdk/modules/import/spec/module.yaml',
				),
				['id: import.core', 'specVersion: 1.2.4', 'name: Data import'].join(
					'\n',
				),
			);
			expect(
				readModuleCatalog(workspace).find(
					(entry) => entry.id === 'import.core',
				),
			).toMatchObject({ name: 'Data import', specVersion: '1.2.4' });
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	describe('through the composed platform', () => {
		let composition: PlatformServerComposition;
		let modules: SystemModulesCapability;
		const databases = createPgliteTestProvider();

		beforeAll(() => {
			const capabilities = createPlatformCapabilityRegistry();
			composition = createServerComposition({
				environment: { NODE_ENV: 'test' },
				workspaceRoot: root,
				databases,
				capabilities,
			} as unknown as PlatformServerContext);
			modules = capabilities.get<SystemModulesCapability>(
				SYSTEM_MODULES_CAPABILITY,
			)!;
		});

		afterAll(async () => {
			await composition.dispose?.();
			await databases.dispose();
		});

		it('SYSTEM-MODULE-INACTIVE-NAVIGATION: the shell is told every enabled SDK module is active, as isActive answers', async () => {
			const active = await modules.activeIds('tenant-a');

			expect(active).toEqual([
				'approvals.core',
				'auth.core',
				'example.core',
				'exports.core',
				'import.core',
				'system.core',
			]);
			for (const id of active) {
				expect(await modules.isActive('tenant-a', id)).toBe(true);
			}
		});
	});
});
