import { describe, expect, it } from 'vitest';
import { defineListExport } from '@flowdular/server';
import { moduleDefinition } from '../src/index.ts';
import { EXPORTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { EXPORT_LISTS_CAPABILITY } from '../src/domain/lists.ts';
import { createExportListRegistry } from '../src/services/list-registry.ts';
import { endpoints } from '../src/api/endpoints.ts';
import { storageObjectCeiling } from '../src/platform.ts';
import { DEFAULT_STORAGE_MAX_OBJECT_BYTES } from '@flowdular/storage';

function declaration(id: string) {
	return defineListExport<{ readonly name: string }>({
		id,
		label: 'Rows',
		permission: 'users.members.read',
		columns: [{ key: 'name', header: 'Name', value: (row) => row.name }],
		page: async () => ({ rows: [], nextCursor: null }),
	});
}

describe('exports.core', () => {
	it('exports its validated identity and the capability it provides', () => {
		expect(moduleDefinition.manifest.id).toBe('exports.core');
		expect(moduleDefinition.manifest.provides).toContain(
			EXPORT_LISTS_CAPABILITY,
		);
		expect(moduleDefinition.permissions).toEqual([
			EXPORTS_PERMISSIONS.read,
			EXPORTS_PERMISSIONS.manage,
		]);
	});

	it('declares every endpoint it serves', () => {
		expect([...endpoints]).toEqual([
			'exports.jobs.list',
			'exports.jobs.get',
			'exports.jobs.start',
			'exports.jobs.read-url',
			'exports.lists.catalogue',
		]);
	});
});

describe('the list catalogue', () => {
	it('holds a registration and answers it by id', () => {
		const registry = createExportListRegistry();
		registry.register('users.core', [declaration('users.core.members')]);
		expect(registry.find('users.core.members')?.moduleId).toBe('users.core');
		expect(registry.list().map((entry) => entry.id)).toEqual([
			'users.core.members',
		]);
		expect(registry.find('users.core.absent')).toBeNull();
	});

	it('refuses a list outside the namespace of the module registering it', () => {
		const registry = createExportListRegistry();
		expect(() =>
			registry.register('audit.core', [declaration('users.core.members')]),
		).toThrow(/namespace/);
		expect(registry.list()).toEqual([]);
	});

	it('refuses the same list twice', () => {
		const registry = createExportListRegistry();
		registry.register('users.core', [declaration('users.core.members')]);
		try {
			registry.register('users.core', [declaration('users.core.members')]);
			throw new Error('the duplicate was accepted');
		} catch (error) {
			expect(error).toMatchObject({ code: 'EXPORT_LIST_DUPLICATE' });
		}
		expect(registry.list()).toHaveLength(1);
	});

	it('refuses a registration once the catalogue is sealed', () => {
		const registry = createExportListRegistry();
		registry.seal();
		try {
			registry.register('users.core', [declaration('users.core.members')]);
			throw new Error('a sealed catalogue accepted a registration');
		} catch (error) {
			expect(error).toMatchObject({ code: 'EXPORT_LISTS_SEALED', status: 500 });
		}
	});
});

describe('the storage object ceiling at composition', () => {
	it('reads the configured ceiling', () => {
		expect(
			storageObjectCeiling(
				{ NODE_ENV: 'test', FD_STORAGE_MAX_OBJECT_BYTES: '4096' },
				process.cwd(),
			),
		).toBe(4096);
	});

	it('falls back to the default when the adapter check refuses the environment', () => {
		expect(
			storageObjectCeiling(
				{ NODE_ENV: 'production', FD_STORAGE_ADAPTER: 'local' },
				process.cwd(),
			),
		).toBe(DEFAULT_STORAGE_MAX_OBJECT_BYTES);
	});
});
