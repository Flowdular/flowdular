import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	optionalString,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type { CreatePartyInput, PartyKind } from '../domain/types.ts';
import { PartyServiceError } from '../services/parties-service.ts';
import type { PartiesRuntime } from '../server/runtime.ts';

function failure(error: unknown): Response {
	if (error instanceof PartyServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The party operation failed.');
}

export function createPartyRoutes(auth: AuthRuntime, runtime: PartiesRuntime) {
	const list = defineEndpoint({
		id: 'parties.records.list',
		path: '/api/parties',
		methods: ['GET'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) =>
			jsonResponse({
				parties: runtime.service().list(principalFromContext(octane)!.tenantId),
			}),
	});
	const create = defineEndpoint({
		id: 'parties.records.create',
		path: '/api/parties',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const kind = requiredString(value, 'kind');
				if (kind !== 'customer' && kind !== 'supplier' && kind !== 'both') {
					throw new HttpProblem(
						'INVALID_PARTY_KIND',
						'kind must be customer, supplier, or both.',
						400,
					);
				}
				const input: CreatePartyInput = {
					name: requiredString(value, 'name', { min: 2, max: 160 }),
					kind: kind as PartyKind,
					email: optionalString(value, 'email', 254),
					phone: optionalString(value, 'phone', 40),
				};
				return jsonResponse(
					{
						party: runtime
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
	'parties.records.list',
	'parties.records.create',
] as const;
