import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/sdk/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { catalogNavigationLabel } from '../src/client/navigation-copy.ts';
import { moduleDefinition } from '../src/index.ts';
import {
	CatalogService,
	CatalogServiceError,
} from '../src/services/catalog-service.ts';
import {
	closeCatalogTestDatabases,
	createCatalogTestDatabase,
	type CatalogTestDatabase,
} from './support/database.ts';

const TEST_ACTOR = {
	kind: 'user',
	id: 'account-1',
	label: 'Test user',
} as const;

const databases = new Set<CatalogTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeCatalogTestDatabases);

async function catalogFixture(): Promise<CatalogTestDatabase> {
	const database = await createCatalogTestDatabase();
	databases.add(database);
	return database;
}

async function serviceError(
	action: () => unknown,
): Promise<CatalogServiceError> {
	try {
		await action();
	} catch (error) {
		if (error instanceof CatalogServiceError) return error;
		throw error;
	}
	throw new Error('Expected a CatalogServiceError.');
}

describe('catalog.core', () => {
	it('ships matching English and Polish translation keys', async () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('resolves the navigation label from the registered module bundle', async () => {
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

	it('translates every dynamic record and history value', async () => {
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

	it('exports its validated identity', async () => {
		expect(moduleDefinition.manifest.id).toBe('catalog.core');
	});

	it('enforces SKU uniqueness inside one tenant only', async () => {
		const service = new CatalogService((await catalogFixture()).repository);
		const input = {
			sku: 'consulting',
			name: 'Consulting hour',
			kind: 'service' as const,
			unit: 'hour',
			basePriceMinor: 12_000,
			currency: 'EUR',
		};
		await service.create('tenant-a', input, TEST_ACTOR);
		await expect(
			service.create('tenant-a', input, TEST_ACTOR),
		).rejects.toThrowError(/active tenant/);
		await expect(
			service.create('tenant-b', input, TEST_ACTOR),
		).resolves.toBeDefined();
	});

	it('isolates item lists by trusted tenant id', async () => {
		const service = new CatalogService((await catalogFixture()).repository);
		await service.create(
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
		expect(await service.list('tenant-b')).toEqual([]);
	});

	it('keeps lifecycle revisions append-only and tenant-scoped', async () => {
		const service = new CatalogService((await catalogFixture()).repository);
		const item = await service.create(
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
		await service.update(
			'tenant-a',
			{ ...item, name: 'Alpha revised', basePriceMinor: 125 },
			TEST_ACTOR,
		);
		expect(
			await serviceError(() => service.delete('tenant-a', item.id, TEST_ACTOR)),
		).toMatchObject({ code: 'CATALOG_ITEM_NOT_ARCHIVED', status: 409 });
		expect((await service.get('tenant-a', item.id))?.status).toBe('active');
		await service.archive('tenant-a', item.id, {
			kind: 'agent',
			id: 'catalog-agent',
			label: 'Catalog curator',
			runId: 'run-1',
		});
		await service.restore('tenant-a', item.id, TEST_ACTOR);
		await service.archive('tenant-a', item.id, TEST_ACTOR);
		await service.delete('tenant-a', item.id, TEST_ACTOR);

		const history = await service.history('tenant-a', {
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
			(
				await service.history('tenant-b', {
					recordId: item.id,
					limit: 20,
					cursor: null,
				})
			).entries,
		).toEqual([]);
	});

	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await catalogFixture();

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO catalog_items
							 (id, tenant_id, sku, sku_normalized, name, kind, unit,
							  base_price_minor, currency, status, created_at)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
						parameters: [
							'forged',
							'tenant-b',
							'F-1',
							'f-1',
							'Forged',
							'product',
							'each',
							1,
							'EUR',
							'active',
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await catalogFixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});
});
