import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type HistoryPage,
	type HistoryRequest,
} from '@coreloom/kernel';
import type {
	CatalogItem,
	CatalogItemKind,
	CreateCatalogItemInput,
	UpdateCatalogItemInput,
} from '../domain/types.ts';
import { DuplicateSkuError, type CatalogRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyConflictError,
} from './target-idempotency.ts';

export interface CatalogIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
}

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

function trustedActor(actor: Actor): Actor {
	const normalized = normalizeActor(actor);
	if (!normalized) {
		throw new CatalogServiceError(
			'INVALID_ACTOR',
			'actor must carry a kind, an id, and a label.',
		);
	}
	return normalized;
}

export class CatalogService {
	constructor(private readonly repository: CatalogRepository) {}

	list(tenantId: string): readonly CatalogItem[] {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	get(tenantId: string, id: string): CatalogItem | null {
		return this.repository.find(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
		);
	}

	create(
		tenantId: string,
		input: CreateCatalogItemInput,
		actor: Actor,
	): CatalogItem {
		const item = this.newItem(tenantId, input);
		return this.persistCreate(item, trustedActor(actor));
	}

	createIdempotent(
		tenantId: string,
		input: CreateCatalogItemInput,
		actor: Actor,
		idempotency: CatalogIdempotencyRequest,
	): CatalogItem {
		const item = this.newItem(tenantId, input);
		const trusted = trustedActor(actor);
		try {
			return this.repository.createIdempotent(
				item,
				item.sku.toLocaleLowerCase('en-US'),
				trusted,
				{
					key: bounded(idempotency.key, 'idempotencyKey', 8, 128),
					operationId: bounded(idempotency.operationId, 'operationId', 3, 160),
					inputDigest: canonicalDigest({
						sku: item.sku,
						name: item.name,
						kind: item.kind,
						unit: item.unit,
						basePriceMinor: item.basePriceMinor,
						currency: item.currency,
					}),
				},
			);
		} catch (error) {
			if (error instanceof TargetIdempotencyConflictError) {
				throw new CatalogServiceError(error.code, error.message, 409);
			}
			if (error instanceof DuplicateSkuError) {
				throw new CatalogServiceError('DUPLICATE_SKU', error.message, 409);
			}
			throw error;
		}
	}

	private newItem(
		tenantId: string,
		input: CreateCatalogItemInput,
	): CatalogItem {
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
		return {
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
	}

	private persistCreate(item: CatalogItem, actor: Actor): CatalogItem {
		try {
			return this.repository.create(
				item,
				item.sku.toLocaleLowerCase('en-US'),
				actor,
			);
		} catch (error) {
			if (error instanceof DuplicateSkuError) {
				throw new CatalogServiceError('DUPLICATE_SKU', error.message, 409);
			}
			throw error;
		}
	}

	update(
		tenantId: string,
		input: UpdateCatalogItemInput,
		actor: Actor,
	): CatalogItem {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const current = this.item(trustedTenantId, input.id);
		if (
			!Number.isSafeInteger(input.basePriceMinor) ||
			input.basePriceMinor < 0
		) {
			throw new CatalogServiceError(
				'INVALID_PRICE',
				'basePriceMinor must be a non-negative integer.',
			);
		}
		const currency = bounded(input.currency, 'currency', 3, 3).toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			throw new CatalogServiceError(
				'INVALID_CURRENCY',
				'currency must be a three-letter ISO code.',
			);
		}
		const updated = this.repository.update(
			{
				...current,
				name: bounded(input.name, 'name', 2, 160),
				kind: itemKind(input.kind),
				unit: bounded(input.unit, 'unit', 1, 24),
				basePriceMinor: input.basePriceMinor,
				currency,
			},
			trustedActor(actor),
		);
		if (!updated) throw this.notFound();
		return updated;
	}

	archive(tenantId: string, id: string, actor: Actor): CatalogItem {
		return this.changeStatus(tenantId, id, 'archived', actor);
	}

	restore(tenantId: string, id: string, actor: Actor): CatalogItem {
		return this.changeStatus(tenantId, id, 'active', actor);
	}

	delete(tenantId: string, id: string, actor: Actor): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const trustedId = bounded(id, 'id', 1, 128);
		const current = this.item(trustedTenantId, trustedId);
		if (current.status !== 'archived') {
			throw new CatalogServiceError(
				'CATALOG_ITEM_NOT_ARCHIVED',
				'Archive the catalog item before deleting it permanently.',
				409,
			);
		}
		if (
			!this.repository.delete(trustedTenantId, trustedId, trustedActor(actor))
		) {
			throw this.notFound();
		}
	}

	history(tenantId: string, request: HistoryRequest): HistoryPage {
		return this.repository.history({
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recordId: bounded(request.recordId, 'recordId', 1, 128),
			limit: request.limit,
			cursor: request.cursor,
		});
	}

	private item(tenantId: string, id: string): CatalogItem {
		const item = this.repository.find(tenantId, bounded(id, 'id', 1, 128));
		if (!item) throw this.notFound();
		return item;
	}

	private notFound(): CatalogServiceError {
		return new CatalogServiceError(
			'CATALOG_ITEM_NOT_FOUND',
			'The catalog item was not found in the active tenant.',
			404,
		);
	}

	private changeStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): CatalogItem {
		const item = this.repository.setStatus(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
			status,
			trustedActor(actor),
		);
		if (!item) throw this.notFound();
		return item;
	}
}
