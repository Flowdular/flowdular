import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	bumpModuleVersion,
	describeModuleVersion,
	type ModuleVersionReport,
} from '../src/module-version.ts';
import type { Workspace } from '../src/workspace.ts';

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const authManifest = `{
	"schemaVersion": 1,
	"id": "auth.core",
	"package": "@flowdular/module-auth",
	"version": "0.11.0",
	"profile": "full",
	"capabilities": ["api", "client"],
	"dependencies": [
		{
			"id": "system.core",
			"range": "^0.5.1"
		}
	],
	"tenancy": "required",
	"locales": ["en"],
	"stability": "experimental"
}
`;

const authPackage = `{
	"name": "@flowdular/module-auth",
	"version": "0.11.0",
	"dependencies": {
		"@flowdular/module-system": "workspace:*"
	}
}
`;

const authSpec = `schemaVersion: 1
id: auth.core
specVersion: 0.11.0
status: approved
dependencies:
  - id: system.core
    range: ^0.5.1
`;

const usersManifest = `{
	"schemaVersion": 1,
	"id": "users.core",
	"package": "@flowdular/module-users",
	"version": "0.7.0",
	"profile": "full",
	"capabilities": ["client"],
	"dependencies": [
		{
			"id": "system.core",
			"range": "^0.5.1"
		},
		{
			"id": "auth.core",
			"range": "^0.11.0"
		}
	],
	"tenancy": "required",
	"locales": ["en"],
	"stability": "experimental"
}
`;

const usersSpec = `schemaVersion: 1
id: users.core
specVersion: 0.7.0
dependencies:
  - id: system.core
    range: ^0.5.1
  - id: auth.core
    range: ^0.11.0
`;

const systemManifest = `{
	"schemaVersion": 1,
	"id": "system.core",
	"package": "@flowdular/module-system",
	"version": "0.5.1",
	"profile": "full",
	"capabilities": ["client"],
	"dependencies": [],
	"tenancy": "none",
	"locales": ["en"],
	"stability": "stable"
}
`;

async function fixture(extra: Record<string, string> = {}): Promise<Workspace> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-version-'));
	roots.push(root);
	const files: Record<string, string> = {
		'modules/auth/module.json': authManifest,
		'modules/auth/package.json': authPackage,
		'modules/auth/spec/module.yaml': authSpec,
		'modules/users/module.json': usersManifest,
		'modules/users/spec/module.yaml': usersSpec,
		'modules/system/module.json': systemManifest,
		...extra,
	};
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const config = { modules: { roots: ['modules'], enabled: [] } };
	await writeFile(join(root, 'flowdular.json'), JSON.stringify(config));
	return { root, configPath: join(root, 'flowdular.json'), config };
}

describe('module version bump', () => {
	it('previews without writing', async () => {
		const workspace = await fixture();
		const result = await bumpModuleVersion(workspace, {
			id: 'auth.core',
			level: 'minor',
			apply: false,
		});
		expect(result.ok).toBe(true);
		const report = result.data as ModuleVersionReport;
		expect(report).toMatchObject({
			previous: '0.11.0',
			next: '0.12.0',
			applied: false,
		});
		expect(report.files.map((file) => file.path).sort()).toEqual([
			'modules/auth/module.json',
			'modules/auth/package.json',
			'modules/auth/spec/module.yaml',
			'modules/users/module.json',
			'modules/users/spec/module.yaml',
		]);
		expect(
			await readFile(join(workspace.root, 'modules/auth/module.json'), 'utf8'),
		).toBe(authManifest);
	});

	it('writes the three versions and retargets dependents that stop matching', async () => {
		const workspace = await fixture();
		const result = await bumpModuleVersion(workspace, {
			id: 'auth.core',
			level: 'minor',
			apply: true,
		});
		expect(result.ok).toBe(true);
		const read = (path: string) => readFile(join(workspace.root, path), 'utf8');
		expect(await read('modules/auth/module.json')).toBe(
			authManifest.replace('"version": "0.11.0"', '"version": "0.12.0"'),
		);
		expect(await read('modules/auth/package.json')).toBe(
			authPackage.replace('"version": "0.11.0"', '"version": "0.12.0"'),
		);
		expect(await read('modules/auth/spec/module.yaml')).toBe(
			authSpec.replace('specVersion: 0.11.0', 'specVersion: 0.12.0'),
		);
		expect(await read('modules/users/module.json')).toBe(
			usersManifest.replace('"range": "^0.11.0"', '"range": "^0.12.0"'),
		);
		expect(await read('modules/users/spec/module.yaml')).toBe(
			usersSpec.replace('range: ^0.11.0', 'range: ^0.12.0'),
		);
		expect(await read('modules/system/module.json')).toBe(systemManifest);
	});

	it('leaves a dependent range alone while it still accepts the version', async () => {
		const workspace = await fixture();
		const result = await bumpModuleVersion(workspace, {
			id: 'auth.core',
			level: 'patch',
			apply: true,
		});
		expect(result.ok).toBe(true);
		const report = result.data as ModuleVersionReport;
		expect(report.files.map((file) => file.path)).not.toContain(
			'modules/users/module.json',
		);
		expect(
			await readFile(join(workspace.root, 'modules/users/module.json'), 'utf8'),
		).toBe(usersManifest);
	});

	it('accepts a spec that was already bumped ahead of the manifest', async () => {
		const workspace = await fixture({
			'modules/auth/spec/module.yaml': authSpec.replace(
				'specVersion: 0.11.0',
				'specVersion: 0.12.0',
			),
		});
		const result = await bumpModuleVersion(workspace, {
			id: 'auth.core',
			level: 'minor',
			apply: false,
		});
		expect(result.ok).toBe(true);
		expect((result.data as ModuleVersionReport).manual).toEqual([]);
	});

	it('reports a compound range for a manual edit', async () => {
		const workspace = await fixture({
			'modules/users/module.json': usersManifest.replace(
				'"range": "^0.11.0"',
				'"range": ">=0.11.0 <0.12.0"',
			),
		});
		const result = await bumpModuleVersion(workspace, {
			id: 'auth.core',
			level: 'minor',
			apply: false,
		});
		expect(result.ok).toBe(true);
		expect((result.data as ModuleVersionReport).manual).toEqual([
			'modules/users/module.json: range ">=0.11.0 <0.12.0" for auth.core excludes 0.12.0',
		]);
	});

	it('refuses an unknown level, an unknown module and an installed module', async () => {
		const workspace = await fixture({
			'flowdular.modules.lock.json': JSON.stringify({
				schemaVersion: 1,
				modules: [{ id: 'users.core', directory: 'modules/users' }],
			}),
		});
		expect(
			(
				await bumpModuleVersion(workspace, {
					id: 'auth.core',
					level: 'huge',
					apply: false,
				})
			).error?.code,
		).toBe('USAGE_ERROR');
		expect(
			(
				await bumpModuleVersion(workspace, {
					id: 'billing.core',
					level: 'patch',
					apply: false,
				})
			).error?.code,
		).toBe('MODULE_NOT_FOUND');
		expect(
			(
				await bumpModuleVersion(workspace, {
					id: 'users.core',
					level: 'patch',
					apply: false,
				})
			).error?.code,
		).toBe('MODULE_INSTALLER_MANAGED');
	});
});

describe('module version', () => {
	it('describes the version and its dependents', async () => {
		const workspace = await fixture();
		const result = await describeModuleVersion(workspace, 'auth.core');
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({
			id: 'auth.core',
			version: '0.11.0',
			platformApi: null,
			dependents: [{ id: 'users.core', range: '^0.11.0' }],
		});
	});
});
