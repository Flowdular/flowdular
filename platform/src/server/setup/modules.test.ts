import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enabledDatabaseModules } from './modules.ts';

const roots: string[] = [];

function workspace(
	project: unknown,
	modules: readonly {
		readonly directory: string;
		readonly manifest: unknown;
	}[],
): string {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-modules-'));
	roots.push(root);
	writeFileSync(join(root, 'flowdular.json'), JSON.stringify(project));
	for (const module of modules) {
		const directory = join(root, 'modules', module.directory);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, 'module.json'),
			JSON.stringify(module.manifest),
		);
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('enabled database modules', () => {
	it('keeps only enabled modules that own tables, in project order', () => {
		const root = workspace({ modules: { enabled: ['b.core', 'a.core'] } }, [
			{
				directory: 'a',
				manifest: {
					id: 'a.core',
					capabilities: ['api', 'database'],
					tenancy: 'required',
				},
			},
			{
				directory: 'b',
				manifest: {
					id: 'b.core',
					capabilities: ['api', 'database'],
					tenancy: 'none',
				},
			},
			{
				directory: 'c',
				manifest: { id: 'c.core', capabilities: ['client'] },
			},
		]);

		const enabled = enabledDatabaseModules(root);

		expect(enabled.approximated).toBe(false);
		expect(
			enabled.modules.map((module) => [module.moduleId, module.tenantOwned]),
		).toEqual([
			['b.core', false],
			['a.core', true],
		]);
	});

	it('skips a module that is present but not enabled', () => {
		const root = workspace({ modules: { enabled: ['a.core'] } }, [
			{
				directory: 'a',
				manifest: {
					id: 'a.core',
					capabilities: ['database'],
					tenancy: 'required',
				},
			},
			{
				directory: 'z',
				manifest: {
					id: 'z.core',
					capabilities: ['database'],
					tenancy: 'required',
				},
			},
		]);

		expect(
			enabledDatabaseModules(root).modules.map((module) => module.moduleId),
		).toEqual(['a.core']);
	});

	it('assumes the strictest requirements when no manifest is readable', () => {
		const root = workspace({ modules: { enabled: ['a.core', 'b.core'] } }, []);

		const enabled = enabledDatabaseModules(root);

		expect(enabled.approximated).toBe(true);
		expect(enabled.modules.map((module) => module.moduleId)).toEqual([
			'a.core',
			'b.core',
		]);
		expect(enabled.modules.every((module) => module.tenantOwned)).toBe(true);
	});

	it('falls back to the manifest bundled at build time', () => {
		const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-empty-'));
		roots.push(root);

		const enabled = enabledDatabaseModules(root);

		/* A container image ships only platform/dist, so the enabled list has to
		   survive without flowdular.json beside the process. */
		expect(enabled.approximated).toBe(true);
		expect(enabled.modules.map((module) => module.moduleId)).toContain(
			'auth.core',
		);
	});

	it('asks every module for PostgreSQL and a migration lock', () => {
		const root = workspace({ modules: { enabled: ['a.core'] } }, [
			{
				directory: 'a',
				manifest: {
					id: 'a.core',
					capabilities: ['database'],
					tenancy: 'required',
				},
			},
		]);

		const [module] = enabledDatabaseModules(root).modules;

		expect(module?.dialectIds).toEqual(['postgresql']);
		expect(module?.capabilities).toContain('flowdular.database.migration-lock');
		expect(module?.capabilities).toContain('flowdular.database.transactions');
	});
});
