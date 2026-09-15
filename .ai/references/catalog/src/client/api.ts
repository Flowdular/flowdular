import { t } from '@flowdular/sdk/client/i18n';
import type { HistoryPage } from '@flowdular/sdk/kernel';
import type {
	CatalogBulkOutcome,
	CatalogItem,
	CatalogItemKind,
	CatalogItemStatus,
	CatalogListSort,
	CreateCatalogItemInput,
	UpdateCatalogItemInput,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export class ApiError extends Error {
	readonly status: number;
	/** Stable server code; '' when the response carried none. */
	readonly code: string;

	constructor(status: number, message: string, code = '') {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? t('catalog.error.request'),
			value.error?.code ?? '',
		);
	}
	return value;
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return payload<T>(response);
}

export interface CatalogListRequest {
	readonly sort: CatalogListSort;
	readonly direction: 'asc' | 'desc';
	readonly limit: number;
	/** A substring of the name or the SKU; '' narrows nothing. */
	readonly query: string;
	readonly kind: '' | CatalogItemKind;
	readonly status: '' | CatalogItemStatus;
	/** The cursor that opens this page; null asks for the first one. */
	readonly cursor: string | null;
}

export interface CatalogListPage {
	readonly items: readonly CatalogItem[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** One server-sorted, server-narrowed, server-paged listing; the screen narrows nothing. */
export async function loadCatalogItems(
	request: CatalogListRequest,
): Promise<CatalogListPage> {
	const parameters = new URLSearchParams({
		sort: request.sort,
		direction: request.direction,
		limit: String(request.limit),
	});
	if (request.query !== '') parameters.set('q', request.query);
	if (request.kind !== '') parameters.set('kind', request.kind);
	if (request.status !== '') parameters.set('status', request.status);
	if (request.cursor !== null) parameters.set('cursor', request.cursor);
	const response = await fetch('/api/catalog/items?' + parameters.toString(), {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<CatalogListPage>(response);
}

export async function createCatalogItem(
	input: CreateCatalogItemInput,
	csrfToken: string,
): Promise<CatalogItem> {
	return (
		await post<{ readonly item: CatalogItem }>(
			'/api/catalog/items',
			input,
			csrfToken,
		)
	).item;
}

async function mutateItem(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<CatalogItem> {
	return (await post<{ readonly item: CatalogItem }>(path, body, csrfToken))
		.item;
}

export function updateCatalogItem(
	input: UpdateCatalogItemInput,
	csrfToken: string,
): Promise<CatalogItem> {
	return mutateItem('/api/catalog/items/update', input, csrfToken);
}

export function archiveCatalogItem(
	id: string,
	csrfToken: string,
): Promise<CatalogItem> {
	return mutateItem('/api/catalog/items/archive', { id }, csrfToken);
}

export function restoreCatalogItem(
	id: string,
	csrfToken: string,
): Promise<CatalogItem> {
	return mutateItem('/api/catalog/items/restore', { id }, csrfToken);
}

type OutcomesResponse = { readonly outcomes: readonly CatalogBulkOutcome[] };

/* The selected rows, one outcome per id. */
export async function archiveCatalogItems(
	ids: readonly string[],
	csrfToken: string,
): Promise<readonly CatalogBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/catalog/items/archive-many',
			{ ids },
			csrfToken,
		)
	).outcomes;
}

export async function restoreCatalogItems(
	ids: readonly string[],
	csrfToken: string,
): Promise<readonly CatalogBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/catalog/items/restore-many',
			{ ids },
			csrfToken,
		)
	).outcomes;
}

export async function deleteCatalogItem(
	id: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: true }>(
		'/api/catalog/items/delete',
		{ id },
		csrfToken,
	);
}

/* exports.core owns the job, its file and the screen that hands it over, so the
   Catalog screen only starts one. */
export async function startListExport(
	list: string,
	csrfToken: string,
): Promise<void> {
	await post<unknown>('/api/exports/start', { list }, csrfToken);
}

export async function loadCatalogItemHistory(
	recordId: string,
): Promise<HistoryPage> {
	const response = await fetch(
		`/api/catalog/items/history?recordId=${encodeURIComponent(recordId)}&limit=100`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<HistoryPage>(response);
}
