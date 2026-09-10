import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type HistoryPage,
	type HistoryRequest,
} from '@flowdular/sdk/kernel';
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

	async list(tenantId: string): Promise<readonly CatalogItem[]> {
		return await this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	async get(tenantId: string, id: string): Promise<CatalogItem | null> {
		return await this.repository.find(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
		);
	}

	async create(
		tenantId: string,
		input: CreateCatalogItemInput,
		actor: Actor,
	): Promise<CatalogItem> {
		const item = this.newItem(tenantId, input);
		return await this.persistCreate(item, trustedActor(actor));
	}

	async createIdempotent(
		tenantId: string,
		input: CreateCatalogItemInput,
		actor: Actor,
		idempotency: CatalogIdempotencyRequest,
	): Promise<CatalogItem> {
		const item = this.newItem(tenantId, input);
		const trusted = trustedActor(actor);
		try {
			return await this.repository.createIdempotent(
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

	private async persistCreate(
		item: CatalogItem,
		actor: Actor,
	): Promise<CatalogItem> {
		try {
			return await this.repository.create(
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

	async update(
		tenantId: string,
		input: UpdateCatalogItemInput,
		actor: Actor,
	): Promise<CatalogItem> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const current = await this.item(trustedTenantId, input.id);
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
		const updated = await this.repository.update(
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

	async archive(
		tenantId: string,
		id: string,
		actor: Actor,
	): Promise<CatalogItem> {
		return await this.changeStatus(tenantId, id, 'archived', actor);
	}

	async restore(
		tenantId: string,
		id: string,
		actor: Actor,
	): Promise<CatalogItem> {
		return await this.changeStatus(tenantId, id, 'active', actor);
	}

	async delete(tenantId: string, id: string, actor: Actor): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const trustedId = bounded(id, 'id', 1, 128);
		const current = await this.item(trustedTenantId, trustedId);
		if (current.status !== 'archived') {
			throw new CatalogServiceError(
				'CATALOG_ITEM_NOT_ARCHIVED',
				'Archive the catalog item before deleting it permanently.',
				409,
			);
		}
		if (
			!(await this.repository.delete(
				trustedTenantId,
				trustedId,
				trustedActor(actor),
			))
		) {
			throw this.notFound();
		}
	}

	async history(
		tenantId: string,
		request: HistoryRequest,
	): Promise<HistoryPage> {
		return await this.repository.history({
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recordId: bounded(request.recordId, 'recordId', 1, 128),
			limit: request.limit,
			cursor: request.cursor,
		});
	}

	private async item(tenantId: string, id: string): Promise<CatalogItem> {
		const item = await this.repository.find(
			tenantId,
			bounded(id, 'id', 1, 128),
		);
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

	private async changeStatus(
		tenantId: string,
		id: string,
		status: CatalogItem['status'],
		actor: Actor,
	): Promise<CatalogItem> {
		const item = await this.repository.setStatus(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
			status,
			trustedActor(actor),
		);
		if (!item) throw this.notFound();
		return item;
	}
}
