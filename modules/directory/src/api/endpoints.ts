import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { AuthActor, AuthPrincipal } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { DIRECTORY_PERMISSIONS } from '../acl/permissions.ts';
import {
	PROVISIONING_OPERATIONS,
	PROVISIONING_OUTCOMES,
	type ProvisioningOperation,
	type ProvisioningOutcome,
} from '../domain/types.ts';
import type { DirectoryRuntime } from '../server/runtime.ts';
import { translateAuthError } from '../services/directory-service.ts';
import { DirectoryServiceError } from '../services/service-error.ts';
import { directoryDefaultRole } from '../settings.ts';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';

/** The provisioning log is the one list of this module that grows without end. */
const EVENT_PAGE_LIMIT = 50;
const EVENT_PAGE_MAX = 200;

function failure(error: unknown): Response {
	const translated = translateAuthError(error);
	if (translated instanceof DirectoryServiceError) {
		return jsonResponse(
			{ error: { code: translated.code, message: translated.message } },
			translated.status,
		);
	}
	return problemResponse(translated, 'The directory operation failed.');
}

function actorOf(principal: AuthPrincipal): AuthActor {
	return {
		accountId: principal.accountId,
		tenantId: principal.tenantId,
		email: principal.email,
		role: principal.role,
		scopes: principal.scopes,
	};
}

function optionalExpiry(value: Record<string, unknown>): number | null {
	const expiresAt = value.expiresAt;
	if (expiresAt === undefined || expiresAt === null) return null;
	if (!Number.isSafeInteger(expiresAt)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			'expiresAt must be an integer timestamp in milliseconds.',
			400,
		);
	}
	return expiresAt as number;
}

function queryOneOf<T extends string>(
	url: URL,
	key: string,
	values: readonly T[],
): T | undefined {
	const raw = url.searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (!(values as readonly string[]).includes(raw)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be one of: ${values.join(', ')}.`,
			400,
		);
	}
	return raw as T;
}

export function createDirectoryRoutes(
	auth: AuthRuntime,
	runtime: DirectoryRuntime,
	settings: ModuleSettingsRuntime,
) {
	/* Module-owned and never stored: a cursor names a position in one workspace's
	   own log, so a restart invalidating one costs a client the first page. */
	const cursorSecret = randomBytes(32);

	const mutation = (
		id: string,
		path: string,
		permission: string,
		handle: (
			principal: AuthPrincipal,
			payload: Record<string, unknown>,
		) => Promise<Response>,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					return await handle(
						principalFromContext(octane)!,
						await readJsonObject(octane.request, 4_096),
					);
				} catch (error) {
					return failure(error);
				}
			},
		});

	const listTokens = defineEndpoint({
		id: 'directory.tokens.list',
		path: '/api/directory/tokens',
		methods: ['GET'],
		access: { kind: 'permission', permission: DIRECTORY_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					tokens: await (await runtime.tokens()).list(principal.tenantId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const createToken = mutation(
		'directory.tokens.create',
		'/api/directory/tokens',
		DIRECTORY_PERMISSIONS.manage,
		async (principal, payload) => {
			const issued = await (
				await runtime.tokens()
			).create(principal.tenantId, principal.accountId, {
				label: requiredString(payload, 'label', { min: 2, max: 120 }),
				expiresAt: optionalExpiry(payload),
			});
			/* The only response that carries the value; every later read answers
			   with the fingerprint alone. */
			return jsonResponse(issued, 201);
		},
	);

	const rotateToken = mutation(
		'directory.tokens.rotate',
		'/api/directory/tokens/rotate',
		DIRECTORY_PERMISSIONS.manage,
		async (principal, payload) =>
			jsonResponse(
				await (
					await runtime.tokens()
				).rotate(
					principal.tenantId,
					requiredString(payload, 'id', { max: 128 }),
					optionalExpiry(payload),
				),
			),
	);

	const revokeToken = mutation(
		'directory.tokens.revoke',
		'/api/directory/tokens/revoke',
		DIRECTORY_PERMISSIONS.manage,
		async (principal, payload) =>
			jsonResponse({
				token: await (
					await runtime.tokens()
				).revoke(
					principal.tenantId,
					requiredString(payload, 'id', { max: 128 }),
				),
			}),
	);

	const listGroups = defineEndpoint({
		id: 'directory.groups.list',
		path: '/api/directory/groups',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: DIRECTORY_PERMISSIONS.provisioningRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					await (
						await runtime.administration()
					).listGroupMappings(
						principal.tenantId,
						directoryDefaultRole(settings, principal.tenantId),
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const mapGroup = mutation(
		'directory.groups.map',
		'/api/directory/groups/map',
		DIRECTORY_PERMISSIONS.manage,
		async (principal, payload) =>
			jsonResponse({
				group: await (
					await runtime.administration()
				).mapGroup(
					actorOf(principal),
					{
						id: requiredString(payload, 'id', { max: 128 }),
						roleKey:
							payload.roleKey === undefined ||
							payload.roleKey === null ||
							payload.roleKey === ''
								? null
								: requiredString(payload, 'roleKey', { min: 2, max: 64 }),
						precedence: requiredInteger(payload, 'precedence', {
							min: 0,
							max: 10_000,
						}),
					},
					directoryDefaultRole(settings, principal.tenantId),
				),
			}),
	);

	const listEvents = defineEndpoint({
		id: 'directory.provisioning.list',
		path: '/api/directory/provisioning-events',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: DIRECTORY_PERMISSIONS.provisioningRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: EVENT_PAGE_MAX,
					defaultLimit: EVENT_PAGE_LIMIT,
				});
				const cursor = page.cursor
					? decodeCursor(page.cursor, cursorSecret)
					: null;
				const events = await (
					await runtime.administration()
				).listEvents(principal.tenantId, {
					operation: queryOneOf<ProvisioningOperation>(
						url,
						'operation',
						PROVISIONING_OPERATIONS,
					),
					outcome: queryOneOf<ProvisioningOutcome>(
						url,
						'outcome',
						PROVISIONING_OUTCOMES,
					),
					limit: page.limit,
					...(cursor
						? {
								cursor: {
									occurredAt: Number(cursor.occurredAt),
									sequence: Number(cursor.sequence),
								},
							}
						: {}),
				});
				const last = events.at(-1);
				return pageResponse({
					items: events,
					limit: page.limit,
					nextCursor:
						last && events.length === page.limit
							? encodeCursor(
									{ occurredAt: last.occurredAt, sequence: last.sequence },
									cursorSecret,
								)
							: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		listTokens.serverRoute,
		createToken.serverRoute,
		rotateToken.serverRoute,
		revokeToken.serverRoute,
		listGroups.serverRoute,
		mapGroup.serverRoute,
		listEvents.serverRoute,
	] as const;
}

export const endpoints = [
	'directory.tokens.list',
	'directory.tokens.create',
	'directory.tokens.rotate',
	'directory.tokens.revoke',
	'directory.groups.list',
	'directory.groups.map',
	'directory.provisioning.list',
] as const;
