import type { CatalogItem, CreateCatalogItemInput } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The catalog operation failed.');
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
