import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
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
import type {
	CatalogItemKind,
	CreateCatalogItemInput,
	UpdateCatalogItemInput,
} from '../domain/types.ts';
import { CatalogServiceError } from '../services/catalog-service.ts';
import type { CatalogRuntime } from '../server/runtime.ts';

function failure(error: unknown): Response {
	if (error instanceof CatalogServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The catalog operation failed.');
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
	const list = defineEndpoint({
		id: 'catalog.items.list',
		path: '/api/catalog/items',
		methods: ['GET'],
		access: { kind: 'permission', permission: CATALOG_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) =>
			jsonResponse({
				items: await (
					await runtime.service()
				).list(principalFromContext(octane)!.tenantId),
			}),
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
	'catalog.items.delete',
	'catalog.items.history',
] as const;
