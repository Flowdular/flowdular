import { randomBytes } from 'node:crypto';
import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredInteger,
	requiredString,
} from '@flowdular/sdk/server';
import { parseHistoryRequest } from '@flowdular/sdk/kernel';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import {
	actorFromContext,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/sdk/modules/auth/server';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import {
	CATALOG_BULK_LIMIT,
	CATALOG_LIST_SORTS,
	CATALOG_SEARCH_LENGTH,
	type CatalogItemKind,
	type CatalogListSort,
	type CreateCatalogItemInput,
	type UpdateCatalogItemInput,
} from '../domain/types.ts';
import {
	CatalogServiceError,
	LIST_PAGE_LIMIT,
	LIST_PAGE_MAX_LIMIT,
} from '../services/catalog-service.ts';
import type { CatalogRuntime } from '../server/runtime.ts';
import {
	decodeListCursor,
	encodeListCursor,
	type CatalogListQuery,
} from './list-cursor.ts';

function failure(error: unknown): Response {
	if (error instanceof CatalogServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The catalog operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function listQuery(url: URL): CatalogListQuery {
	const sort = url.searchParams.get('sort') ?? 'name';
	if (!(CATALOG_LIST_SORTS as readonly string[]).includes(sort)) {
		throw invalid(`sort must be one of ${CATALOG_LIST_SORTS.join(', ')}.`);
	}
	const direction = url.searchParams.get('direction') ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw invalid('direction must be asc or desc.');
	}
	const kind = url.searchParams.get('kind') ?? '';
	if (kind !== '' && kind !== 'product' && kind !== 'service') {
		throw invalid('kind must be product or service.');
	}
	const status = url.searchParams.get('status') ?? '';
	if (status !== '' && status !== 'active' && status !== 'archived') {
		throw invalid('status must be active or archived.');
	}
	const search = (url.searchParams.get('q') ?? '').trim();
	if (search.length > CATALOG_SEARCH_LENGTH) {
		throw invalid(
			`q must contain at most ${CATALOG_SEARCH_LENGTH} characters.`,
		);
	}
	return {
		sort: sort as CatalogListSort,
		direction,
		kind: kind === '' ? null : kind,
		status: status === '' ? null : status,
		search,
	};
}

/* One outcome answers one row, so an id is named once; the count and each id
   are bounded like the single route's. */
function requiredIds(value: Record<string, unknown>): readonly string[] {
	const raw = value.ids;
	if (!Array.isArray(raw)) throw invalid('ids must be an array.');
	if (raw.length < 1 || raw.length > CATALOG_BULK_LIMIT) {
		throw invalid(`ids must name between 1 and ${CATALOG_BULK_LIMIT} items.`);
	}
	const ids = raw.map((entry) =>
		requiredString({ id: entry }, 'id', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw invalid('ids must not repeat an id.');
	}
	return ids;
}

function mutableInput(
	value: Record<string, unknown>,
): Omit<UpdateCatalogItemInput, 'id'> {
	const kind = requiredString(value, 'kind');
	if (kind !== 'product' && kind !== 'service') {
		throw new HttpProblem(
			'INVALID_ITEM_KIND',
			'kind must be product or service.',
			400,
		);
	}
	return {
		name: requiredString(value, 'name', { min: 2, max: 160 }),
		kind: kind as CatalogItemKind,
		unit: requiredString(value, 'unit', { max: 24 }),
		basePriceMinor: requiredInteger(value, 'basePriceMinor', { min: 0 }),
		currency: requiredString(value, 'currency', { min: 3, max: 3 }),
	};
}

export function createCatalogRoutes(
	auth: AuthRuntime,
	runtime: CatalogRuntime,
) {
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, so a restart invalidating one costs a client the
	   first page. */
	const cursorSecret = randomBytes(32);
	const list = defineEndpoint({
		id: 'catalog.items.list',
		path: '/api/catalog/items',
		methods: ['GET'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const tenantId = principalFromContext(octane)!.tenantId;
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: LIST_PAGE_MAX_LIMIT,
					defaultLimit: LIST_PAGE_LIMIT,
				});
				const query = listQuery(url);
				const result = await (
					await runtime.service()
				).listPage(tenantId, {
					...query,
					limit: page.limit,
					after: page.cursor
						? decodeListCursor(cursorSecret, page.cursor, tenantId, query)
						: null,
				});
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor: result.next
						? encodeListCursor(cursorSecret, tenantId, query, result.next)
						: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const create = defineEndpoint({
		id: 'catalog.items.create',
		path: '/api/catalog/items',
		methods: ['POST'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request);
				const mutable = mutableInput(value);
				const input: CreateCatalogItemInput = {
					sku: requiredString(value, 'sku', { max: 64 }),
					...mutable,
				};
				return jsonResponse(
					{
						item: await service.create(
							principalFromContext(octane)!.tenantId,
							input,
							actorFromContext(octane)!,
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const update = defineEndpoint({
		id: 'catalog.items.update',
		path: '/api/catalog/items/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request);
				return jsonResponse({
					item: await service.update(
						principalFromContext(octane)!.tenantId,
						{
							id: requiredString(value, 'id', { max: 128 }),
							...mutableInput(value),
						},
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const lifecycle = (action: 'archive' | 'restore', path: string, id: string) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: CATALOG_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const service = await runtime.service();
					const item = await service[action](
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'id', { max: 128 }),
						actorFromContext(octane)!,
					);
					return jsonResponse({ item });
				} catch (error) {
					return failure(error);
				}
			},
		});
	const archive = lifecycle(
		'archive',
		'/api/catalog/items/archive',
		'catalog.items.archive',
	);
	const restore = lifecycle(
		'restore',
		'/api/catalog/items/restore',
		'catalog.items.restore',
	);
	/* The bulk sibling of a lifecycle route: same permission and CSRF rule,
	   one outcome per id through the same service path. */
	const lifecycleMany = (
		action: 'archiveMany' | 'restoreMany',
		path: string,
		id: string,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: CATALOG_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const service = await runtime.service();
					const outcomes = await service[action](
						principalFromContext(octane)!.tenantId,
						requiredIds(value),
						actorFromContext(octane)!,
					);
					return jsonResponse({ outcomes });
				} catch (error) {
					return failure(error);
				}
			},
		});
	const archiveMany = lifecycleMany(
		'archiveMany',
		'/api/catalog/items/archive-many',
		'catalog.items.archive-many',
	);
	const restoreMany = lifecycleMany(
		'restoreMany',
		'/api/catalog/items/restore-many',
		'catalog.items.restore-many',
	);
	const remove = defineEndpoint({
		id: 'catalog.items.delete',
		path: '/api/catalog/items/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request);
				await service.delete(
					principalFromContext(octane)!.tenantId,
					requiredString(value, 'id', { max: 128 }),
					actorFromContext(octane)!,
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const history = defineEndpoint({
		id: 'catalog.items.history',
		path: '/api/catalog/items/history',
		methods: ['GET'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const request = parseHistoryRequest(
				new URL(octane.request.url).searchParams,
			);
			if (!request) {
				return jsonResponse(
					{
						error: {
							code: 'INVALID_INPUT',
							message: 'recordId is required.',
						},
					},
					400,
				);
			}
			try {
				const service = await runtime.service();
				return jsonResponse(
					await service.history(
						principalFromContext(octane)!.tenantId,
						request,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [
		list.serverRoute,
		create.serverRoute,
		update.serverRoute,
		archive.serverRoute,
		restore.serverRoute,
		archiveMany.serverRoute,
		restoreMany.serverRoute,
		remove.serverRoute,
		history.serverRoute,
	] as const;
}

export const endpoints = [
	'catalog.items.list',
	'catalog.items.create',
	'catalog.items.update',
	'catalog.items.archive',
	'catalog.items.restore',
	'catalog.items.archive-many',
	'catalog.items.restore-many',
	'catalog.items.delete',
	'catalog.items.history',
] as const;
