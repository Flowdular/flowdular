import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { PROFILE_PERMISSIONS } from '../acl/permissions.ts';
import type { UpdateProfileInput } from '../domain/types.ts';
import { ProfileServiceError } from '../services/profile-service.ts';
import type { ProfileRuntime } from '../server/runtime.ts';

function failure(error: unknown): Response {
	if (error instanceof ProfileServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The profile operation failed.');
}

export function assertSelfOnlyProfileTarget(
	request: Request,
	value?: Record<string, unknown>,
): void {
	const search = new URL(request.url).searchParams;
	if (
		search.has('tenantId') ||
		search.has('accountId') ||
		(value &&
			(Object.hasOwn(value, 'tenantId') || Object.hasOwn(value, 'accountId')))
	) {
		throw new HttpProblem(
			'PROFILE_TARGET_FORBIDDEN',
			'Profile targeting is not allowed.',
			403,
		);
	}
}

function updateInput(value: Record<string, unknown>): UpdateProfileInput {
	if (typeof value.displayName !== 'string') {
		throw new HttpProblem(
			'INVALID_INPUT',
			'displayName must be a string.',
			400,
		);
	}
	return { displayName: value.displayName };
}

export function createProfileRoutes(
	auth: AuthRuntime,
	runtime: ProfileRuntime,
) {
	const read = defineEndpoint({
		id: 'profile.self.read',
		path: '/api/profile',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: PROFILE_PERMISSIONS.manageSelf,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				assertSelfOnlyProfileTarget(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					profile: await service.read(principal.tenantId, principal.accountId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const update = defineEndpoint({
		id: 'profile.self.update',
		path: '/api/profile',
		methods: ['PUT'],
		access: {
			kind: 'permission',
			permission: PROFILE_PERMISSIONS.manageSelf,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				assertSelfOnlyProfileTarget(octane.request, value);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					profile: await service.update(
						principal.tenantId,
						principal.accountId,
						updateInput(value),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const readLanguage = defineEndpoint({
		id: 'profile.language.read',
		path: '/api/profile/language',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: PROFILE_PERMISSIONS.manageSelf,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				assertSelfOnlyProfileTarget(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					locale: await service.readLanguage(
						principal.tenantId,
						principal.accountId,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const updateLanguage = defineEndpoint({
		id: 'profile.language.update',
		path: '/api/profile/language',
		methods: ['PUT'],
		access: {
			kind: 'permission',
			permission: PROFILE_PERMISSIONS.manageSelf,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				assertSelfOnlyProfileTarget(octane.request, value);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					preference: await service.updateLanguage(
						principal.tenantId,
						principal.accountId,
						{
							locale: requiredString(value, 'locale', { min: 2, max: 16 }),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [
		read.serverRoute,
		update.serverRoute,
		readLanguage.serverRoute,
		updateLanguage.serverRoute,
	] as const;
}

export const endpoints = [
	'profile.self.read',
	'profile.self.update',
	'profile.language.read',
	'profile.language.update',
] as const;
