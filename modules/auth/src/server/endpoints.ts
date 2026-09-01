import { timingSafeEqual } from 'node:crypto';
import { ServerRoute, type Context } from '@octanejs/app-core';
import { readJsonObject } from '@coreloom/server';
import { PLATFORM_SCOPES } from '../acl/scopes.ts';
import type { SignInInput, SignUpInput } from '../domain/types.ts';
import { AttemptLimiter } from '../api/attempt-limiter.ts';
import { clientAddress } from '../api/client-address.ts';
import {
	expiredSessionCookie,
	readCookie,
	sessionCookie,
} from '../api/cookies.ts';
import { assertSameOrigin } from '../api/origin.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import { normalizeEmail } from '../services/validation.ts';
import { createAuditRoutes } from './audit-endpoints.ts';
import {
	actorOf,
	errorResponse,
	requireScope,
	requireSession,
	response,
	sessionPayload,
	stringField,
} from './http.ts';
import { createRoleRoutes } from './roles-endpoints.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';
import { createSessionRoutes } from './session-endpoints.ts';
import { createApiTokenRoutes } from './token-endpoints.ts';

/* Credential guessing is throttled per submitted address and, when a trusted
   proxy reports it, per client address. The account lockout in the service
   is the durable second line. */
const emailAttempts = new AttemptLimiter();
const addressAttempts = new AttemptLimiter(20, 5 * 60 * 1000);
const availabilityAttempts = new AttemptLimiter(60, 60_000);

function throttle(
	context: Context,
	runtime: AuthRuntime,
	email: string,
): { readonly address: string | null; clear(): void } {
	const key = normalizeEmail(email);
	const address = clientAddress(context.request, runtime.trustProxy);
	if (
		!emailAttempts.consume(key) ||
		(address !== null && !addressAttempts.consume(address))
	) {
		throw new AuthServiceError('RATE_LIMITED', 'Try again later.', 429);
	}
	return { address, clear: () => emailAttempts.clear(key) };
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

export function createAuthRoutes(runtime: AuthRuntime): readonly ServerRoute[] {
	const configuration = new ServerRoute({
		path: '/api/auth/config',
		methods: ['GET'],
		handler: () =>
			response({
				allowSignUp: runtime.settings.allowSignUp,
				emailConfirmation: runtime.settings.emailConfirmation,
				signInProviders: runtime.settings.signInProviders,
				passwordMinLength: runtime.settings.passwordMinLength,
			}),
	});

	const workspaceAvailability = new ServerRoute({
		path: '/api/auth/workspace-availability',
		methods: ['GET'],
		handler: (context) => {
			try {
				if (!runtime.settings.allowSignUp) {
					throw new AuthServiceError(
						'SIGN_UP_DISABLED',
						'Account creation is disabled for this deployment.',
						403,
					);
				}
				const agent = context.request.headers.get('user-agent') ?? 'unknown';
				if (
					!availabilityAttempts.consume(`availability:${agent.slice(0, 120)}`)
				) {
					throw new AuthServiceError('RATE_LIMITED', 'Try again later.', 429);
				}
				const slug =
					new URL(context.request.url).searchParams.get('slug') ?? '';
				return response(runtime.service().checkWorkspaceSlug(slug));
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const session = new ServerRoute({
		path: '/api/auth/session',
		methods: ['GET'],
		handler: (context) => {
			const token = readCookie(context.request, runtime.cookie.name);
			const current = token ? runtime.service().resolveSession(token) : null;
			return current
				? response(sessionPayload(current, runtime))
				: response(
						{
							error: { code: 'UNAUTHENTICATED', message: 'No active session.' },
						},
						401,
					);
		},
	});

	const signUp = new ServerRoute({
		path: '/api/auth/sign-up',
		methods: ['POST'],
		handler: async (context) => {
			try {
				if (!runtime.settings.allowSignUp) {
					throw new AuthServiceError(
						'SIGN_UP_DISABLED',
						'Account creation is disabled for this deployment.',
						403,
					);
				}
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const input: SignUpInput = {
					email: stringField(body, 'email'),
					password: stringField(body, 'password'),
					displayName: stringField(body, 'displayName'),
					organizationName: stringField(body, 'organizationName'),
					organizationSlug: stringField(body, 'organizationSlug'),
				};
				const attempt = throttle(context, runtime, input.email);
				const issued = await runtime.service().signUp(input);
				attempt.clear();
				return response(sessionPayload(issued, runtime), 201, {
					'set-cookie': sessionCookie(issued.token, runtime.cookie),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const signIn = new ServerRoute({
		path: '/api/auth/sign-in',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const input: SignInInput = {
					email: stringField(body, 'email'),
					password: stringField(body, 'password'),
				};
				const attempt = throttle(context, runtime, input.email);
				const issued = await runtime
					.service()
					.signIn(input, { address: attempt.address });
				attempt.clear();
				return response(sessionPayload(issued, runtime), 200, {
					'set-cookie': sessionCookie(issued.token, runtime.cookie),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const signOut = new ServerRoute({
		path: '/api/auth/sign-out',
		methods: ['POST'],
		handler: (context) => {
			try {
				assertSameOrigin(context);
				const token = readCookie(context.request, runtime.cookie.name);
				const current = token ? runtime.service().resolveSession(token) : null;
				if (!token || !current) {
					throw new AuthServiceError(
						'UNAUTHENTICATED',
						'Authentication is required.',
						401,
					);
				}
				const submitted = context.request.headers.get('x-csrf-token') ?? '';
				if (!safeEqual(submitted, current.csrfToken)) {
					throw new AuthServiceError(
						'CSRF_REJECTED',
						'CSRF token is invalid.',
						403,
					);
				}
				runtime.service().signOut(token);
				return response({ ok: true }, 200, {
					'set-cookie': expiredSessionCookie(runtime.cookie),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const switchTenant = new ServerRoute({
		path: '/api/auth/switch-tenant',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const token = readCookie(context.request, runtime.cookie.name);
				const current = token ? runtime.service().resolveSession(token) : null;
				if (!token || !current) {
					throw new AuthServiceError(
						'UNAUTHENTICATED',
						'Authentication is required.',
						401,
					);
				}
				const submitted = context.request.headers.get('x-csrf-token') ?? '';
				if (!safeEqual(submitted, current.csrfToken)) {
					throw new AuthServiceError(
						'CSRF_REJECTED',
						'CSRF token is invalid.',
						403,
					);
				}
				const body = await readJsonObject(context.request);
				const tenantId = stringField(body, 'tenantId');
				if (!tenantId || tenantId.length > 128) {
					throw new AuthServiceError(
						'INVALID_INPUT',
						'tenantId is invalid.',
						400,
					);
				}
				const issued = await runtime.service().switchTenant(token, tenantId);
				return response(sessionPayload(issued, runtime), 200, {
					'set-cookie': sessionCookie(issued.token, runtime.cookie),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const changePassword = new ServerRoute({
		path: '/api/auth/password',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const token = readCookie(context.request, runtime.cookie.name);
				const session = token ? runtime.service().resolveSession(token) : null;
				if (!session) {
					throw new AuthServiceError(
						'UNAUTHENTICATED',
						'Authentication is required.',
						401,
					);
				}
				if (
					!safeEqual(
						context.request.headers.get('x-csrf-token') ?? '',
						session.csrfToken,
					)
				) {
					throw new AuthServiceError(
						'CSRF_REJECTED',
						'CSRF token is invalid.',
						403,
					);
				}
				const body = await readJsonObject(context.request);
				await runtime.service().changePassword({
					accountId: session.principal.accountId,
					currentPassword: stringField(body, 'currentPassword'),
					newPassword: stringField(body, 'newPassword'),
					keepSessionToken: token,
				});
				return response({ changed: true });
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	/* The workspace name is a tenant attribute, not a module setting: the
	   principal already carries it, so there is one place it lives. */
	const renameWorkspace = new ServerRoute({
		path: '/api/auth/workspace',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context, runtime);
				requireScope(session, PLATFORM_SCOPES.settingsManage);
				const body = await readJsonObject(context.request);
				return response({
					tenant: runtime
						.service()
						.renameTenant(actorOf(session), stringField(body, 'name')),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	return [
		configuration,
		changePassword,
		workspaceAvailability,
		session,
		signUp,
		signIn,
		switchTenant,
		signOut,
		renameWorkspace,
		...createApiTokenRoutes(runtime),
		...createRoleRoutes(runtime),
		...createAuditRoutes(runtime),
		...createSessionRoutes(runtime),
	];
}
