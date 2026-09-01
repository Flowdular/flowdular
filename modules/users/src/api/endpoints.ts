import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
	type EndpointExecutionContext,
} from '@coreloom/server';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import {
	AuthServiceError,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@coreloom/module-auth/server';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
import {
	UsersService,
	type CreateUserInput,
} from '../services/users-service.ts';

type Context = EndpointExecutionContext['octane'];

function errorResponse(error: unknown): Response {
	return error instanceof AuthServiceError
		? jsonResponse(
				{ error: { code: error.code, message: error.message } },
				error.status,
			)
		: problemResponse(error, 'User operation failed.');
}

function scopes(value: Record<string, unknown>): readonly string[] {
	const result = value.scopes;
	if (
		!Array.isArray(result) ||
		result.length > 256 ||
		result.some((entry) => typeof entry !== 'string')
	) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'scopes must be an array of scope identifiers.',
			400,
		);
	}
	return result as readonly string[];
}

/* Passwords pass through here only as request input on the way to auth.core;
   they are never stored, logged, or echoed by users.core. */
function passwordField(value: Record<string, unknown>, key: string): string {
	const result = value[key];
	if (typeof result !== 'string') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a string.`, 400);
	}
	return result;
}

export function createUserRoutes(auth: AuthRuntime) {
	const users = new UsersService(auth);

	const mutation = (
		id: string,
		path: string,
		handle: (
			octane: Context,
			payload: Record<string, unknown>,
		) => Promise<Response> | Response,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: USER_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					return await handle(octane, await readJsonObject(octane.request));
				} catch (error) {
					return errorResponse(error);
				}
			},
		});

	const list = defineEndpoint({
		id: 'users.members.list',
		path: '/api/users',
		methods: ['GET'],
		access: { kind: 'permission', permission: USER_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) =>
			jsonResponse(users.list(principalFromContext(octane)!)),
	});

	const create = mutation(
		'users.members.create',
		'/api/users',
		async (octane, payload) => {
			const input: CreateUserInput = {
				email: requiredString(payload, 'email', { max: 254 }),
				password: passwordField(payload, 'password'),
				displayName: requiredString(payload, 'displayName', { max: 80 }),
				role: requiredString(payload, 'role', { max: 32 }),
			};
			return jsonResponse(
				{ user: await users.create(principalFromContext(octane)!, input) },
				201,
			);
		},
	);

	const update = mutation(
		'users.members.update',
		'/api/users/update',
		(octane, payload) =>
			jsonResponse({
				user: users.rename(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					requiredString(payload, 'displayName', { max: 80 }),
				),
			}),
	);

	const role = mutation(
		'users.members.role',
		'/api/users/role',
		(octane, payload) =>
			jsonResponse({
				user: users.assignRole(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					requiredString(payload, 'role', { max: 32 }),
				),
			}),
	);

	const status = mutation(
		'users.members.status',
		'/api/users/status',
		(octane, payload) => {
			const value = requiredString(payload, 'status', { max: 16 });
			if (value !== 'active' && value !== 'disabled') {
				throw new HttpProblem(
					'INVALID_INPUT',
					'status must be active or disabled.',
					400,
				);
			}
			return jsonResponse({
				user: users.setStatus(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					value,
				),
			});
		},
	);

	const remove = mutation(
		'users.members.remove',
		'/api/users/remove',
		(octane, payload) => {
			users.remove(
				principalFromContext(octane)!,
				requiredString(payload, 'accountId', { max: 128 }),
			);
			return jsonResponse({ removed: true });
		},
	);

	const resetPassword = mutation(
		'users.members.password-reset',
		'/api/users/password-reset',
		async (octane, payload) =>
			jsonResponse({
				user: await users.resetPassword(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					passwordField(payload, 'temporaryPassword'),
				),
			}),
	);

	const setScopes = mutation(
		'users.members.scopes',
		'/api/users/scopes',
		(octane, payload) =>
			jsonResponse({
				user: users.setScopes(
					principalFromContext(octane)!,
					requiredString(payload, 'accountId', { max: 128 }),
					scopes(payload),
				),
			}),
	);

	return [
		list.serverRoute,
		create.serverRoute,
		update.serverRoute,
		role.serverRoute,
		status.serverRoute,
		remove.serverRoute,
		resetPassword.serverRoute,
		setScopes.serverRoute,
	] as const;
}

export const endpoints = [
	'users.members.list',
	'users.members.create',
	'users.members.update',
	'users.members.role',
	'users.members.status',
	'users.members.remove',
	'users.members.password-reset',
	'users.members.scopes',
] as const;
