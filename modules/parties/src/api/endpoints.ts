import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	optionalString,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@coreloom/server';
import { parseHistoryRequest } from '@coreloom/kernel';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	actorFromContext,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type {
	CreatePartyInput,
	PartyKind,
	UpdatePartyInput,
} from '../domain/types.ts';
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

function partyInput(value: Record<string, unknown>): CreatePartyInput {
	const kind = requiredString(value, 'kind');
	if (kind !== 'customer' && kind !== 'supplier' && kind !== 'both') {
		throw new HttpProblem(
			'INVALID_PARTY_KIND',
			'kind must be customer, supplier, or both.',
			400,
		);
	}
	return {
		name: requiredString(value, 'name', { min: 2, max: 160 }),
		kind: kind as PartyKind,
		email: optionalString(value, 'email', 254),
		phone: optionalString(value, 'phone', 40),
		vatId: optionalString(value, 'vatId', 20),
	};
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
				const input = partyInput(value);
				return jsonResponse(
					{
						party: runtime
							.service()
							.create(
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
		id: 'parties.records.update',
		path: '/api/parties/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const input: UpdatePartyInput = {
					id: requiredString(value, 'id', { max: 128 }),
					...partyInput(value),
				};
				return jsonResponse({
					party: runtime
						.service()
						.update(
							principalFromContext(octane)!.tenantId,
							input,
							actorFromContext(octane)!,
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const archive = defineEndpoint({
		id: 'parties.records.archive',
		path: '/api/parties/archive',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse({
					party: runtime
						.service()
						.archive(
							principalFromContext(octane)!.tenantId,
							requiredString(value, 'id', { max: 128 }),
							actorFromContext(octane)!,
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const restore = defineEndpoint({
		id: 'parties.records.restore',
		path: '/api/parties/restore',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse({
					party: runtime
						.service()
						.restore(
							principalFromContext(octane)!.tenantId,
							requiredString(value, 'id', { max: 128 }),
							actorFromContext(octane)!,
						),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const remove = defineEndpoint({
		id: 'parties.records.delete',
		path: '/api/parties/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, 4 * 1_024);
				runtime
					.service()
					.delete(
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
		id: 'parties.records.history',
		path: '/api/parties/history',
		methods: ['GET'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
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
				return jsonResponse(
					runtime
						.service()
						.history(principalFromContext(octane)!.tenantId, request),
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
	'parties.records.list',
	'parties.records.create',
	'parties.records.update',
	'parties.records.archive',
	'parties.records.restore',
	'parties.records.delete',
	'parties.records.history',
] as const;
