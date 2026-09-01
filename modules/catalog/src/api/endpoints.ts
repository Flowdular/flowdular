import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import { CATALOG_PERMISSIONS } from '../acl/permissions.ts';
import type {
	CatalogItemKind,
	CreateCatalogItemInput,
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
		handler: ({ octane }) =>
			jsonResponse({
				items: runtime.service().list(principalFromContext(octane)!.tenantId),
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
				const value = await readJsonObject(octane.request);
				const kind = requiredString(value, 'kind');
				if (kind !== 'product' && kind !== 'service') {
					throw new HttpProblem(
						'INVALID_ITEM_KIND',
						'kind must be product or service.',
						400,
					);
				}
				const input: CreateCatalogItemInput = {
					sku: requiredString(value, 'sku', { max: 64 }),
					name: requiredString(value, 'name', { min: 2, max: 160 }),
					kind: kind as CatalogItemKind,
					unit: requiredString(value, 'unit', { max: 24 }),
					basePriceMinor: requiredInteger(value, 'basePriceMinor', { min: 0 }),
					currency: requiredString(value, 'currency', { min: 3, max: 3 }),
				};
				return jsonResponse(
					{
						item: runtime
							.service()
							.create(principalFromContext(octane)!.tenantId, input),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [list.serverRoute, create.serverRoute] as const;
}

export const endpoints = [
	'catalog.items.list',
	'catalog.items.create',
] as const;
