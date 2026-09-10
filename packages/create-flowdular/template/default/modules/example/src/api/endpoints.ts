import {
	defineEndpoint,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@flowdular/sdk/server';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/sdk/modules/auth/server';
import { EXAMPLE_PERMISSIONS } from '../acl/permissions.ts';
import { NoteServiceError } from '../services/note-service.ts';
import type { ExampleRuntime } from '../server/runtime.ts';

function failure(error: unknown): Response {
	if (error instanceof NoteServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The example operation failed.');
}

export function createExampleRoutes(
	auth: AuthRuntime,
	runtime: ExampleRuntime,
) {
	const list = defineEndpoint({
		id: 'example.notes.list',
		path: '/api/example/notes',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXAMPLE_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({ notes: await service.list(principal.tenantId) });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const create = defineEndpoint({
		id: 'example.notes.create',
		path: '/api/example/notes',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXAMPLE_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse(
					{
						note: await service.create(principal.tenantId, {
							title: requiredString(value, 'title', { min: 1, max: 120 }),
							body: requiredString(value, 'body', { min: 1, max: 4_000 }),
						}),
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
	'example.notes.list',
	'example.notes.create',
] as const;
