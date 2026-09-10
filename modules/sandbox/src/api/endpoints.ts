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
	isTokenPrincipal,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import type { Context } from '@octanejs/app-core';
import { SANDBOX_PERMISSIONS } from '../acl/permissions.ts';
import type { SandboxSessionState } from '../domain/types.ts';
import { SandboxServiceError } from '../services/sandbox-service-error.ts';
import type { SandboxRuntime } from '../server/runtime.ts';

/* A browser session is guarded by CSRF. An API token is never sent
   automatically by a browser, so it carries no CSRF risk and is checked by its
   scopes alone. */
function mutationDenial(context: Context, auth: AuthRuntime): Response | null {
	return isTokenPrincipal(context)
		? null
		: sessionMutationDenial(context, auth);
}

function failure(error: unknown): Response {
	if (error instanceof SandboxServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The sandbox operation failed.');
}

function optionalCapabilities(
	value: Record<string, unknown>,
): readonly string[] | undefined {
	const raw = value.capabilities;
	if (raw === undefined || raw === null) return undefined;
	if (
		!Array.isArray(raw) ||
		raw.length > 8 ||
		raw.some((entry) => typeof entry !== 'string')
	) {
		throw new HttpProblem(
			'INVALID_CAPABILITIES',
			'capabilities must be an array of capability identifiers.',
			400,
		);
	}
	return raw as readonly string[];
}

function optionalExpiry(value: Record<string, unknown>): number | null {
	const raw = value.expiresAt;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
		throw new HttpProblem(
			'INVALID_EXPIRY',
			'expiresAt must be an integer timestamp in milliseconds.',
			400,
		);
	}
	return raw;
}

function optionalNote(value: Record<string, unknown>): string | null {
	const raw = value.note;
	if (raw === undefined || raw === null || raw === '') return null;
	if (typeof raw !== 'string' || raw.length > 280) {
		throw new HttpProblem(
			'INVALID_NOTE',
			'note must be a string of at most 280 characters.',
			400,
		);
	}
	return raw;
}

function ejectMetadata(
	value: Record<string, unknown>,
): Readonly<Record<string, string | number | boolean>> {
	const raw = value.metadata;
	if (raw === undefined || raw === null) return {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new HttpProblem(
			'INVALID_METADATA',
			'metadata must be an object of strings, numbers, and booleans.',
			400,
		);
	}
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > 20) {
		throw new HttpProblem(
			'INVALID_METADATA',
			'metadata may hold at most 20 entries.',
			400,
		);
	}
	const metadata: Record<string, string | number | boolean> = {};
	for (const [key, entry] of entries) {
		if (
			!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) ||
			(typeof entry !== 'boolean' &&
				typeof entry !== 'number' &&
				(typeof entry !== 'string' || entry.length > 500))
		) {
			throw new HttpProblem(
				'INVALID_METADATA',
				'metadata must be an object of strings, numbers, and booleans.',
				400,
			);
		}
		metadata[key] = entry;
	}
	return metadata;
}

export function createSandboxRoutes(
	auth: AuthRuntime,
	runtime: SandboxRuntime,
) {
	const access = defineEndpoint({
		id: 'sandbox.access.snapshot',
		path: '/api/sandbox/access',
		methods: ['GET'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			const service = await runtime.service(auth);
			return jsonResponse({
				sandbox: { url: runtime.options.sandboxUrl },
				grants: await service.listGrants(principal.tenantId),
				candidates: await service.listCandidates(principal.tenantId),
			});
		},
	});

	const grant = defineEndpoint({
		id: 'sandbox.access.create-grant',
		path: '/api/sandbox/access',
		methods: ['POST'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				return jsonResponse(
					{
						grant: await (
							await runtime.service(auth)
						).grant({
							tenantId: principal.tenantId,
							actorId: principal.accountId,
							accountId: requiredString(value, 'accountId', { max: 128 }),
							capabilities: optionalCapabilities(value),
							expiresAt: optionalExpiry(value),
							note: optionalNote(value),
						}),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const revoke = defineEndpoint({
		id: 'sandbox.access.revoke-grant',
		path: '/api/sandbox/access/revoke',
		methods: ['POST'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				return jsonResponse({
					grant: await (
						await runtime.service(auth)
					).revoke(
						principal.tenantId,
						requiredString(value, 'accountId', { max: 128 }),
						principal.accountId,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const sessions = defineEndpoint({
		id: 'sandbox.sessions.snapshot',
		path: '/api/sandbox/sessions',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: SANDBOX_PERMISSIONS.sessionsRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				sessions: await (
					await runtime.service(auth)
				).listSessions(principal.tenantId, 50),
			});
		},
	});

	const audit = defineEndpoint({
		id: 'sandbox.audit.snapshot',
		path: '/api/sandbox/audit',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: SANDBOX_PERMISSIONS.sessionsRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				const limit = Number(url.searchParams.get('limit') ?? '50');
				return jsonResponse(
					await (
						await runtime.service(auth)
					).pageAuditEvents(
						principal.tenantId,
						url.searchParams.get('cursor'),
						Number.isSafeInteger(limit) ? limit : 50,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const verifyAudit = defineEndpoint({
		id: 'sandbox.audit.verify',
		path: '/api/sandbox/audit/verify',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: SANDBOX_PERMISSIONS.sessionsRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					await (await runtime.service(auth)).verifyAudit(principal.tenantId),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const authority = defineEndpoint({
		id: 'sandbox.authority.resolve',
		path: '/api/sandbox/authority',
		methods: ['GET'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.use },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				principal: {
					accountId: principal.accountId,
					tenantId: principal.tenantId,
					email: principal.email,
					displayName: principal.displayName,
					role: principal.role,
					scopes: principal.scopes,
					tenantName:
						principal.tenants.find(
							(tenant) => tenant.tenantId === principal.tenantId,
						)?.name ?? principal.tenantId,
					tenantSlug:
						principal.tenants.find(
							(tenant) => tenant.tenantId === principal.tenantId,
						)?.slug ?? '',
				},
				authority: await (
					await runtime.service(auth)
				).authorize(principal.tenantId, principal.accountId, principal.scopes),
				sandbox: { url: runtime.options.sandboxUrl },
			});
		},
	});

	const registerSession = defineEndpoint({
		id: 'sandbox.sessions.register',
		path: '/api/sandbox/sessions',
		methods: ['POST'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.use },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = mutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				const mode = requiredString(value, 'mode', { max: 16 });
				if (mode !== 'loopback' && mode !== 'self-hosted') {
					throw new HttpProblem(
						'INVALID_MODE',
						'mode must be loopback or self-hosted.',
						400,
					);
				}
				return jsonResponse(
					{
						session: await (
							await runtime.service(auth)
						).registerSession({
							tenantId: principal.tenantId,
							accountId: principal.accountId,
							sessionId: requiredString(value, 'sessionId', { max: 128 }),
							moduleId: requiredString(value, 'moduleId', { max: 128 }),
							title: requiredString(value, 'title', { min: 2, max: 120 }),
							blueprint: requiredString(value, 'blueprint', { max: 120 }),
							driver: requiredString(value, 'driver', { max: 64 }),
							mode,
						}),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const updateSessionState = defineEndpoint({
		id: 'sandbox.sessions.transition',
		path: '/api/sandbox/sessions/state',
		methods: ['POST'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.use },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = mutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				return jsonResponse({
					session: await (
						await runtime.service(auth)
					).updateSessionState(
						principal.tenantId,
						requiredString(value, 'sessionId', { max: 128 }),
						requiredString(value, 'state', {
							max: 32,
						}) as SandboxSessionState,
						principal.accountId,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Eject evidence, written by the sandbox after every step of a delivery
	   passed. Metadata is bounded scalars: what landed, never the sources. */
	const recordEject = defineEndpoint({
		id: 'sandbox.sessions.eject-record',
		path: '/api/sandbox/sessions/eject',
		methods: ['POST'],
		access: { kind: 'permission', permission: SANDBOX_PERMISSIONS.eject },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = mutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				return jsonResponse(
					{
						event: await (
							await runtime.service(auth)
						).recordEject(
							principal.tenantId,
							requiredString(value, 'sessionId', { max: 128 }),
							principal.accountId,
							ejectMetadata(value),
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		authority.serverRoute,
		registerSession.serverRoute,
		updateSessionState.serverRoute,
		recordEject.serverRoute,
		access.serverRoute,
		grant.serverRoute,
		revoke.serverRoute,
		sessions.serverRoute,
		audit.serverRoute,
		verifyAudit.serverRoute,
	] as const;
}

export const endpoints = [
	'sandbox.authority.resolve',
	'sandbox.sessions.register',
	'sandbox.sessions.transition',
	'sandbox.sessions.eject-record',
	'sandbox.access.snapshot',
	'sandbox.access.create-grant',
	'sandbox.access.revoke-grant',
	'sandbox.sessions.snapshot',
	'sandbox.audit.snapshot',
	'sandbox.audit.verify',
] as const;
