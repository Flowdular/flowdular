import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { CatalogService } from '../src/services/catalog-service.ts';
import { SqliteCatalogRepository } from '../src/services/sqlite-repository.ts';

describe('catalog.core', () => {
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
		service.create('tenant-a', input);
		expect(() => service.create('tenant-a', input)).toThrowError(
			/active tenant/,
		);
		expect(() => service.create('tenant-b', input)).not.toThrow();
	});

	it('isolates item lists by trusted tenant id', () => {
		const service = new CatalogService(new SqliteCatalogRepository(':memory:'));
		service.create('tenant-a', {
			sku: 'A-1',
			name: 'Alpha',
			kind: 'product',
			unit: 'each',
			basePriceMinor: 100,
			currency: 'EUR',
		});
		expect(service.list('tenant-b')).toEqual([]);
	});
});
