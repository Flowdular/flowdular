import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { catalogNavigationLabel } from '../src/client/navigation-copy.ts';
import { moduleDefinition } from '../src/index.ts';
import {
	CatalogService,
	CatalogServiceError,
} from '../src/services/catalog-service.ts';
import { SqliteCatalogRepository } from '../src/services/sqlite-repository.ts';

const TEST_ACTOR = {
	kind: 'user',
	id: 'account-1',
	label: 'Test user',
} as const;

function serviceError(action: () => unknown): CatalogServiceError {
	try {
		action();
	} catch (error) {
		if (error instanceof CatalogServiceError) return error;
		throw error;
	}
	throw new Error('Expected a CatalogServiceError.');
}

describe('catalog.core', () => {
	it('ships matching English and Polish translation keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('resolves the navigation label from the registered module bundle', () => {
		registerModuleTranslations([
			{
				moduleId: 'catalog.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('en');
		expect(catalogNavigationLabel()).toBe('Catalog');
		setActiveLocale('pl');
		expect(catalogNavigationLabel()).toBe('Katalog');
		setActiveLocale('en');
	});

	it('translates every dynamic record and history value', () => {
		registerModuleTranslations([
			{
				moduleId: 'catalog.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const kind of ['product', 'service']) {
				const key = 'catalog.kind.' + kind;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const status of ['active', 'archived']) {
				const key = 'catalog.status.' + status;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const action of [
				'created',
				'updated',
				'archived',
				'restored',
				'deleted',
			]) {
				const key = 'catalog.history.action.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const actor of ['user', 'agent']) {
				const key = 'catalog.history.actor.' + actor;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			const serviceKey = 'catalog.history.actor.serviceConfiguredBy';
			expect(
				t(serviceKey, { name: 'Ada' }),
				`${locale}: ${serviceKey}`,
			).not.toBe(serviceKey);
			for (const field of [
				'sku',
				'name',
				'kind',
				'unit',
				'basePriceMinor',
				'currency',
				'status',
			]) {
				const key = 'catalog.history.field.' + field;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('catalog.core');
	});

	it('enforces SKU uniqueness inside one tenant only', () => {
		const service = new CatalogService(new SqliteCatalogRepository(':memory:'));
		const input = {
			sku: 'consulting',
			name: 'Consulting hour',
			kind: 'service' as const,
			unit: 'hour',
			basePriceMinor: 12_000,
			currency: 'EUR',
		};
		service.create('tenant-a', input, TEST_ACTOR);
		expect(() => service.create('tenant-a', input, TEST_ACTOR)).toThrowError(
			/active tenant/,
		);
		expect(() => service.create('tenant-b', input, TEST_ACTOR)).not.toThrow();
	});

	it('isolates item lists by trusted tenant id', () => {
		const service = new CatalogService(new SqliteCatalogRepository(':memory:'));
		service.create(
			'tenant-a',
			{
				sku: 'A-1',
				name: 'Alpha',
				kind: 'product',
				unit: 'each',
				basePriceMinor: 100,
				currency: 'EUR',
			},
			TEST_ACTOR,
		);
		expect(service.list('tenant-b')).toEqual([]);
	});

	it('keeps lifecycle revisions append-only and tenant-scoped', () => {
		const service = new CatalogService(new SqliteCatalogRepository(':memory:'));
		const item = service.create(
			'tenant-a',
			{
				sku: 'A-1',
				name: 'Alpha',
				kind: 'product',
				unit: 'each',
				basePriceMinor: 100,
				currency: 'EUR',
			},
			TEST_ACTOR,
		);
		service.update(
			'tenant-a',
			{ ...item, name: 'Alpha revised', basePriceMinor: 125 },
			TEST_ACTOR,
		);
		expect(
			serviceError(() => service.delete('tenant-a', item.id, TEST_ACTOR)),
		).toMatchObject({ code: 'CATALOG_ITEM_NOT_ARCHIVED', status: 409 });
		expect(service.get('tenant-a', item.id)?.status).toBe('active');
		service.archive('tenant-a', item.id, {
			kind: 'agent',
			id: 'catalog-agent',
			label: 'Catalog curator',
			runId: 'run-1',
		});
		service.restore('tenant-a', item.id, TEST_ACTOR);
		service.archive('tenant-a', item.id, TEST_ACTOR);
		service.delete('tenant-a', item.id, TEST_ACTOR);

		const history = service.history('tenant-a', {
			recordId: item.id,
			limit: 20,
			cursor: null,
		});
		expect(history.entries.map((entry) => entry.action)).toEqual([
			'deleted',
			'archived',
			'restored',
			'archived',
			'updated',
			'created',
		]);
		expect(history.entries[3]?.actor).toEqual({
			kind: 'agent',
			id: 'catalog-agent',
			label: 'Catalog curator',
			runId: 'run-1',
		});
		expect(history.entries[4]?.changes).toEqual({
			name: { from: 'Alpha', to: 'Alpha revised' },
			basePriceMinor: { from: 100, to: 125 },
		});
		expect(
			service.history('tenant-b', {
				recordId: item.id,
				limit: 20,
				cursor: null,
			}).entries,
		).toEqual([]);
	});
});
