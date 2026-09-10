import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from '../module.json' with { type: 'json' };
import translationsEn from '../translations/en.json' with { type: 'json' };
import translationsPl from '../translations/pl.json' with { type: 'json' };
import { EXAMPLE_PERMISSIONS, permissions } from '../src/acl/permissions.ts';
import { endpoints } from '../src/api/endpoints.ts';
import { databaseMigrations } from '../src/services/migration.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);

describe('example.core manifest', () => {
	it('declares the identifier the platform composes', () => {
		expect(manifest.id).toBe('example.core');
		expect(manifest.package).toBe('@app/module-example');
		expect(manifest.tenancy).toBe('required');
	});

	it('declares one permission per action the API enforces', () => {
		expect([...permissions]).toEqual([
			'example.notes.read',
			'example.notes.manage',
		]);
		expect(EXAMPLE_PERMISSIONS.read).toBe('example.notes.read');
		expect(endpoints).toEqual(['example.notes.list', 'example.notes.create']);
	});
});

describe('example.core translations', () => {
	it('ships the same key set in every declared locale', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		expect(manifest.locales).toEqual(['en', 'pl']);
	});

	it('never ships an empty string', () => {
		for (const bundle of [translationsEn, translationsPl]) {
			for (const [key, value] of Object.entries(bundle)) {
				expect(value.trim(), key).not.toBe('');
			}
		}
	});
});

describe('example.core migrations', () => {
	it('mirrors every PostgreSQL up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(
					new URL(`${migration.id}.up.sql`, migrationDirectory),
					'utf8',
				),
			);
		}
	});

	it('declares forced row security for every tenant table', () => {
		for (const migration of databaseMigrations) {
			const sql = migration.sql.postgresql ?? '';
			expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
			expect(sql).toContain('FORCE ROW LEVEL SECURITY');
			expect(sql).toContain("current_setting('coreloom.tenant_id', true)");
			expect(sql).toContain('WITH CHECK');
		}
	});
});
