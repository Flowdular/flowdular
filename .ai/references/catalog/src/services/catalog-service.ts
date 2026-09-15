import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type DataClassExportSink,
	type DataClassExportSummary,
	type HistoryPage,
	type HistoryRequest,
} from '@flowdular/sdk/kernel';
import {
	CATALOG_BULK_LIMIT,
	CATALOG_LIST_SORTS,
	CATALOG_SEARCH_LENGTH,
	type CatalogBulkOutcome,
	type CatalogItem,
	type CatalogItemKind,
	type CatalogItemStatus,
	type CatalogListSort,
	type CreateCatalogItemInput,
	type UpdateCatalogItemInput,
} from '../domain/types.ts';
import {
	DuplicateSkuError,
	type CatalogListPage,
	type CatalogPageKeyset,
	type CatalogRepository,
	type ExportCursor,
} from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyConflictError,
} from './target-idempotency.ts';

export interface CatalogIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
}

/** Rows one export read carries; the whole tenant is walked page by page. */
export const EXPORT_PAGE = 200;

/** The default page of the items list, and the most a read may ask for. */
export const LIST_PAGE_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 200;

/** One list page as a caller asks for it, before the service validates it. */
export interface CatalogListInput {
	readonly sort: CatalogListSort;
	readonly direction: 'asc' | 'desc';
	readonly kind: CatalogItemKind | null;
	readonly status: CatalogItemStatus | null;
	/** A substring of the name or the SKU; '' narrows nothing. */
	readonly search: string;
	readonly limit: number;
	readonly after: CatalogPageKeyset | null;
}

export const FIRST_LIST_PAGE: CatalogListInput = {
	sort: 'name',
	direction: 'asc',
	kind: null,
	status: null,
	search: '',
	limit: LIST_PAGE_MAX_LIMIT,
	after: null,
};

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

function itemStatus(value: CatalogItemStatus): CatalogItemStatus {
	if (value !== 'active' && value !== 'archived') {
		throw new CatalogServiceError(
			'INVALID_INPUT',
			'status must be active or archived.',
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

	/** One server-ordered, server-narrowed page; the only listing the module answers. */
	async listPage(
		tenantId: string,
		input: CatalogListInput,
	): Promise<CatalogListPage> {
		if (!(CATALOG_LIST_SORTS as readonly string[]).includes(input.sort)) {
			throw new CatalogServiceError(
				'INVALID_INPUT',
				`sort must be one of ${CATALOG_LIST_SORTS.join(', ')}.`,
			);
		}
		if (input.direction !== 'asc' && input.direction !== 'desc') {
			throw new CatalogServiceError(
				'INVALID_INPUT',
				'direction must be asc or desc.',
			);
		}
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > LIST_PAGE_MAX_LIMIT
		) {
			throw new CatalogServiceError(
				'INVALID_INPUT',
				`limit must be an integer between 1 and ${LIST_PAGE_MAX_LIMIT}.`,
			);
		}
		const search = bounded(input.search, 'search', 0, CATALOG_SEARCH_LENGTH);
		return await this.repository.listPage(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				sort: input.sort,
				direction: input.direction,
				kind: input.kind === null ? null : itemKind(input.kind),
				status: input.status === null ? null : itemStatus(input.status),
				term: search === '' ? null : search.toLocaleLowerCase('en-US'),
				limit: input.limit,
				after:
					input.after === null
						? null
						: {
								sortValue: bounded(input.after.sortValue, 'cursor', 0, 512),
								id: bounded(input.after.id, 'cursor', 1, 128),
							},
			},
		);
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
		const now = Date.now();
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
			createdAt: now,
			updatedAt: now,
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

	archiveMany(
		tenantId: string,
		ids: readonly string[],
		actor: Actor,
	): Promise<readonly CatalogBulkOutcome[]> {
		return this.each(ids, (id) => this.archive(tenantId, id, actor));
	}

	restoreMany(
		tenantId: string,
		ids: readonly string[],
		actor: Actor,
	): Promise<readonly CatalogBulkOutcome[]> {
		return this.each(ids, (id) => this.restore(tenantId, id, actor));
	}

	/* One outcome per id through the single-row path, so every accepted
	   transition keeps its own history row and a refused id fails no other. */
	private async each(
		ids: readonly string[],
		write: (id: string) => Promise<unknown>,
	): Promise<readonly CatalogBulkOutcome[]> {
		if (ids.length < 1 || ids.length > CATALOG_BULK_LIMIT) {
			throw new CatalogServiceError(
				'INVALID_INPUT',
				`ids must name between 1 and ${CATALOG_BULK_LIMIT} items.`,
			);
		}
		const outcomes: CatalogBulkOutcome[] = [];
		for (const id of ids) {
			try {
				await write(id);
				outcomes.push({ id, outcome: 'updated' });
			} catch (error) {
				if (!(error instanceof CatalogServiceError)) throw error;
				outcomes.push(
					error.code === 'CATALOG_ITEM_NOT_FOUND'
						? { id, outcome: 'not-found' }
						: { id, outcome: 'refused', reason: error.code },
				);
			}
		}
		return outcomes;
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

	async exportItemsTo(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		return await exportPaged(
			(cursor) =>
				this.repository.listItemsForExport(
					trustedTenantId,
					cursor,
					EXPORT_PAGE,
				),
			(item) => item.createdAt,
			(item) => ({
				id: item.id,
				sku: item.sku,
				name: item.name,
				kind: item.kind,
				unit: item.unit,
				basePriceMinor: item.basePriceMinor,
				currency: item.currency,
				status: item.status,
				createdAt: new Date(item.createdAt).toISOString(),
			}),
			sink,
		);
	}

	async exportHistoryTo(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		return await exportPaged(
			(cursor) =>
				this.repository.listHistoryForExport(
					trustedTenantId,
					cursor,
					EXPORT_PAGE,
				),
			(entry) => entry.occurredAt,
			(entry) => ({
				id: entry.id,
				recordId: entry.recordId,
				version: entry.version,
				action: entry.action,
				actor: entry.actor,
				changes: entry.changes,
				occurredAt: new Date(entry.occurredAt).toISOString(),
			}),
			sink,
		);
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

async function exportPaged<T extends { readonly id: string }>(
	page: (after: ExportCursor | null) => Promise<readonly T[]>,
	at: (record: T) => number,
	row: (record: T) => Record<string, unknown>,
	sink: DataClassExportSink,
): Promise<DataClassExportSummary> {
	let cursor: ExportCursor | null = null;
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const records = await page(cursor);
		for (const record of records) {
			await sink.write(row(record));
			rows += 1;
			from ??= new Date(at(record));
			to = new Date(at(record));
		}
		if (records.length < EXPORT_PAGE) break;
		const last = records[records.length - 1]!;
		cursor = { at: at(last), id: last.id };
	}
	return { rows, from, to };
}
