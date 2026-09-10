import { t } from '@flowdular/sdk/client/i18n';
import type { HistoryPage } from '@flowdular/sdk/kernel';
import type {
	CatalogItem,
	CreateCatalogItemInput,
	UpdateCatalogItemInput,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('catalog.error.request'));
	}
	return value;
}

export async function loadCatalogItems(): Promise<readonly CatalogItem[]> {
	const response = await fetch('/api/catalog/items', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly items: readonly CatalogItem[] }>(response))
		.items;
}

export async function createCatalogItem(
	input: CreateCatalogItemInput,
	csrfToken: string,
): Promise<CatalogItem> {
	const response = await fetch('/api/catalog/items', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly item: CatalogItem }>(response)).item;
}

async function mutateItem(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<CatalogItem> {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return (await payload<{ readonly item: CatalogItem }>(response)).item;
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

export async function deleteCatalogItem(
	id: string,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/catalog/items/delete', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	await payload<{ readonly deleted: true }>(response);
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
