import { randomUUID } from 'node:crypto';
import type {
	CatalogItem,
	CatalogItemKind,
	CreateCatalogItemInput,
} from '../domain/types.ts';
import { DuplicateSkuError, type CatalogRepository } from './repository.ts';

export class CatalogServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'CatalogServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new CatalogServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function itemKind(value: CatalogItemKind): CatalogItemKind {
	if (value !== 'product' && value !== 'service') {
		throw new CatalogServiceError(
			'INVALID_ITEM_KIND',
			'kind must be product or service.',
		);
	}
	return value;
}

export class CatalogService {
	constructor(private readonly repository: CatalogRepository) {}

	list(tenantId: string): readonly CatalogItem[] {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	create(tenantId: string, input: CreateCatalogItemInput): CatalogItem {
		if (
			!Number.isSafeInteger(input.basePriceMinor) ||
			input.basePriceMinor < 0
		) {
			throw new CatalogServiceError(
				'INVALID_PRICE',
				'basePriceMinor must be a non-negative integer.',
			);
		}
		const sku = bounded(input.sku, 'sku', 1, 64).toUpperCase();
		const currency = bounded(input.currency, 'currency', 3, 3).toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			throw new CatalogServiceError(
				'INVALID_CURRENCY',
				'currency must be a three-letter ISO code.',
			);
		}
		const item: CatalogItem = {
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			sku,
			name: bounded(input.name, 'name', 2, 160),
			kind: itemKind(input.kind),
			unit: bounded(input.unit, 'unit', 1, 24),
			basePriceMinor: input.basePriceMinor,
			currency,
			status: 'active',
			createdAt: Date.now(),
		};
		try {
			return this.repository.create(item, sku.toLocaleLowerCase('en-US'));
		} catch (error) {
			if (error instanceof DuplicateSkuError) {
				throw new CatalogServiceError('DUPLICATE_SKU', error.message, 409);
			}
			throw error;
		}
	}
}
