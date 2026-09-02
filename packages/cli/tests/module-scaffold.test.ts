import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceFormatter } from '../src/format.ts';
import { scaffoldModule } from '../src/module-scaffold.ts';
import type { Workspace } from '../src/workspace.ts';

const specification = `schemaVersion: 1
id: inventory.core
specVersion: 0.1.0
status: approved
name: Inventory Core
description: Tracks tenant-owned stock for tests.
profile: full
capabilities:
  - api
  - database
  - client
  - translations
dependencies: []
tenancy: required
locales:
  - en
  - pl
invariants:
  - Every record belongs to one tenant.
permissions:
  - id: inventory.records.read
    description: Read inventory records.
  - id: inventory.records.manage
    description: Manage inventory records.
dataOwnership:
  - inventory.core owns inventory records.
acceptanceScenarios:
  - id: INVENTORY-LIST
    given: Inventory records exist.
    when: An authorized principal lists inventory.
    then: Only active tenant records are returned.
`;

const specPath = 'modules/inventory/spec/module.yaml';

async function workspace(): Promise<Workspace> {
	const root = await mkdtemp(join(tmpdir(), 'coreloom-scaffold-'));
	await mkdir(join(root, 'modules/inventory/spec'), { recursive: true });
	await writeFile(join(root, specPath), specification);
	await writeFile(join(root, 'coreloom.json'), '{}\n');
	return { root, configPath: join(root, 'coreloom.json'), config: {} };
}

async function listTree(
	directory: string,
	base = directory,
): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listTree(path, base)));
		else files.push(relative(base, path));
	}
	return files.sort();
}

async function read(root: string, path: string): Promise<string> {
	return readFile(join(root, 'modules/inventory', path), 'utf8');
}

describe('module scaffolding', () => {
	it('produces a module the generated composition can import', async () => {
		const ws = await workspace();
		try {
			const result = await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			expect(result.skipped).toEqual([specPath]);

			const manifest = JSON.parse(await read(ws.root, 'module.json')) as {
				platform: unknown;
				version: string;
			};
			expect(manifest.platform).toEqual({ server: true, client: true });
			expect(manifest.version).toBe('0.1.0');

			const packageJson = JSON.parse(await read(ws.root, 'package.json')) as {
				exports: Record<string, string>;
				scripts: Record<string, string>;
				dependencies: Record<string, string>;
			};
			expect(packageJson.exports).toEqual({
				'.': './src/index.ts',
				'./client': './src/client/index.ts',
				'./server': './src/server/index.ts',
				'./platform': './src/platform.ts',
			});
			expect(packageJson.scripts.typecheck).toContain('tsrx-tsc');
			expect(packageJson.dependencies.octane).toBe('0.1.51');

			const tsconfig = JSON.parse(await read(ws.root, 'tsconfig.json')) as {
				compilerOptions: { types: string[] };
			};
			expect(tsconfig.compilerOptions.types).toEqual(['node']);

			const platform = await read(ws.root, 'src/platform.ts');
			expect(platform).toContain(
				'export function createServerComposition(\n\tcontext: PlatformServerContext,\n): PlatformServerComposition',
			);
			expect(platform).toContain("from '@coreloom/module-auth/server'");
			expect(platform).toContain(
				'createInventoryRoutes(context.auth, runtime)',
			);

			const client = await read(ws.root, 'src/client/index.ts');
			expect(client).toContain(
				'export function createClientContribution(\n\tcontext: ModuleClientContext,\n): ModuleClientContribution',
			);
			expect(client).toContain('csrfToken: context.csrfToken');
			const view = await read(ws.root, 'src/client/InventoryView.tsrx');
			expect(view).toContain('TableCard');
			expect(view).toContain("width: '65%'");
			expect(view).toContain("t('inventory.table.title')");
			expect(view).not.toContain('<table');
			const contribution = await read(ws.root, 'src/client/contribution.tsrx');
			expect(contribution).toContain(
				'translations: { en: translationsEn, pl: translationsPl }',
			);
			expect(contribution).toContain("return t('inventory.navigation.label')");

			expect(await read(ws.root, 'src/acl/permissions.ts')).toContain(
				"read: 'inventory.records.read'",
			);
			const endpoints = await read(ws.root, 'src/api/endpoints.ts');
			expect(endpoints).toContain("path: '/api/inventory/records'");
			expect(endpoints).toContain('INVENTORY_PERMISSIONS.read');
			expect(endpoints).toContain('sessionMutationDenial(octane, auth)');

			const runtime = await read(ws.root, 'src/server/runtime.ts');
			expect(runtime).toContain('CL_INVENTORY_DATABASE');
			expect(runtime).toContain("'/data/inventory.db'");
			expect(runtime).toContain(
				"coreloomLocalDataPath(workspaceRoot, 'inventory.db')",
			);

			const migration = await read(ws.root, 'src/services/migration.ts');
			expect(migration).toContain('INVENTORY_MIGRATION_001');
			expect(migration).toContain('tenant_id TEXT NOT NULL');
			expect(migration).toContain(') STRICT;');
			const upSql = await read(
				ws.root,
				'migrations/0001_inventory_core.up.sql',
			);
			expect(upSql).toContain('CREATE TABLE IF NOT EXISTS inventory_records');
			/* The runner checksums the constant, so it must equal the file. */
			expect(migration).toContain(
				`export const INVENTORY_MIGRATION_001 = \`${upSql}\`;`,
			);
			expect(migration).toContain(
				"{ id: '0001_inventory_core', statements: INVENTORY_MIGRATION_001 },",
			);
			expect(
				await read(ws.root, 'src/services/sqlite-repository.ts'),
			).toContain('runModuleMigrations(this.#database, migrations);');
			expect(
				await read(ws.root, 'migrations/0001_inventory_core.down.sql'),
			).toContain('DROP TABLE IF EXISTS inventory_records');

			const en = JSON.parse(await read(ws.root, 'translations/en.json')) as {
				'module.name': string;
			};
			const pl = JSON.parse(await read(ws.root, 'translations/pl.json')) as {
				'module.name': string;
			};
			expect(en['module.name']).toBe('Inventory Core');
			expect(pl['module.name']).not.toBe(en['module.name']);
			expect(pl['module.name']).toMatch(/^Moduł /);

			const test = await read(ws.root, 'tests/module.test.ts');
			expect(test).toContain("'tenant-a'");
			expect(test).toContain("'tenant-b'");
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('writes files the workspace format gate accepts', async () => {
		const ws = await workspace();
		try {
			const result = await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			expect(result.formatted).toBe(true);
			const formatter = await loadWorkspaceFormatter(ws.root);
			expect(formatter).not.toBeNull();
			const moduleRoot = join(ws.root, 'modules/inventory');
			for (const path of await listTree(moduleRoot)) {
				const source = await readFile(join(moduleRoot, path), 'utf8');
				expect(
					await formatter!.format(join(moduleRoot, path), source),
					path,
				).toBe(source);
			}
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('keeps author-owned translations and reports them as skipped', async () => {
		const ws = await workspace();
		try {
			await mkdir(join(ws.root, 'modules/inventory/translations'), {
				recursive: true,
			});
			await writeFile(
				join(ws.root, 'modules/inventory/translations/pl.json'),
				'{\n\t"module.name": "Magazyn"\n}\n',
			);
			const result = await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			expect(result.skipped).toEqual([
				specPath,
				'modules/inventory/translations/pl.json',
			]);
			expect(await read(ws.root, 'translations/pl.json')).toContain('Magazyn');
			expect(await read(ws.root, 'translations/en.json')).toContain(
				'Inventory Core',
			);
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('refuses a directory that already holds module sources', async () => {
		const ws = await workspace();
		try {
			await mkdir(join(ws.root, 'modules/inventory/src'), { recursive: true });
			await writeFile(
				join(ws.root, 'modules/inventory/src/index.ts'),
				'export {};\n',
			);
			await expect(
				scaffoldModule(ws, { id: 'inventory.core', specPath, apply: false }),
			).rejects.toThrow('already exists');
		} finally {
			await rm(ws.root, { recursive: true, force: true });
		}
	});

	it('leaves no partial output behind when a write fails midway', async () => {
		const ws = await workspace();
		const translations = join(ws.root, 'modules/inventory/translations');
		try {
			await mkdir(translations, { recursive: true });
			await writeFile(join(translations, 'pl.json'), '{}\n');
			await chmod(translations, 0o555);
			await expect(
				scaffoldModule(ws, { id: 'inventory.core', specPath, apply: true }),
			).rejects.toThrow();
			expect(await listTree(join(ws.root, 'modules/inventory'))).toEqual([
				'spec/module.yaml',
				'translations/pl.json',
			]);

			await chmod(translations, 0o755);
			const retry = await scaffoldModule(ws, {
				id: 'inventory.core',
				specPath,
				apply: true,
			});
			expect(retry.applied).toBe(true);
			expect(await listTree(join(ws.root, 'modules/inventory'))).toContain(
				'src/platform.ts',
			);
		} finally {
			await chmod(translations, 0o755).catch(() => undefined);
			await rm(ws.root, { recursive: true, force: true });
		}
	});
});
