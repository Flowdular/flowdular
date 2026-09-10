import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
import { ServerRoute, type Context } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { BUNDLED_MODULE_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import type { SignInInput, SignUpInput } from '../domain/types.ts';
import { AttemptLimiter } from '../api/attempt-limiter.ts';
import { clientAddress } from '../api/client-address.ts';
import {
	expiredSessionCookie,
	readCookie,
	sessionCookie,
} from '../api/cookies.ts';
import { assertSameOrigin } from '../api/origin.ts';
import { sessionFromContext } from '../middleware/authentication.ts';
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
import type { AuthRuntime, OidcProvider } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';
import { createSessionRoutes } from './session-endpoints.ts';
import { createApiTokenRoutes } from './token-endpoints.ts';

/* Credential guessing is throttled per submitted address and, when a trusted
   proxy reports it, per client address. The account lockout in the service
   is the durable second line. */
const emailAttempts = new AttemptLimiter();
const addressAttempts = new AttemptLimiter(20, 5 * 60 * 1000);
const availabilityAttempts = new AttemptLimiter(60, 60_000);
const passwordResetEmailAttempts = new AttemptLimiter(3, 15 * 60 * 1000);
const passwordResetAddressAttempts = new AttemptLimiter(20, 15 * 60 * 1000);
const MFA_CHALLENGE_COOKIE = 'coreloom_mfa_challenge';
const OIDC_STATE_COOKIE = 'coreloom_oidc_state';
const OIDC_REQUEST_TIMEOUT_MS = 10_000;
const OIDC_RESPONSE_MAX_BYTES = 64 * 1024;

interface OidcState {
	readonly provider: string;
	readonly state: string;
	readonly verifier: string;
}

function oidcStateCookie(value: string, secure: boolean, maxAge = 600): string {
	return [
		`${OIDC_STATE_COOKIE}=${encodeURIComponent(value)}`,
		'Path=/api/auth/oidc',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${maxAge}`,
		maxAge === 0 ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '',
		secure ? 'Secure' : '',
	]
		.filter(Boolean)
		.join('; ');
}

function sealOidcState(value: OidcState, provider: OidcProvider): string {
	const payload = Buffer.from(JSON.stringify(value), 'utf8').toString(
		'base64url',
	);
	const signature = createHmac('sha256', provider.clientSecret)
		.update('flowdular:oidc-state:v1\0', 'utf8')
		.update(payload, 'utf8')
		.digest('base64url');
	return `${payload}.${signature}`;
}

function openOidcState(value: string, provider: OidcProvider): OidcState {
	if (value.length > 1024) throw new Error('invalid OIDC state');
	const parts = value.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1])
		throw new Error('invalid OIDC state');
	const expected = createHmac('sha256', provider.clientSecret)
		.update('flowdular:oidc-state:v1\0', 'utf8')
		.update(parts[0], 'utf8')
		.digest('base64url');
	if (!safeEqual(parts[1], expected)) throw new Error('invalid OIDC state');
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
	} catch {
		throw new Error('invalid OIDC state');
	}
	if (!parsed || typeof parsed !== 'object')
		throw new Error('invalid OIDC state');
	const state = parsed as Partial<OidcState>;
	if (
		state.provider !== provider.id ||
		typeof state.state !== 'string' ||
		!/^[A-Za-z0-9_-]{32}$/.test(state.state) ||
		typeof state.verifier !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(state.verifier)
	) {
		throw new Error('invalid OIDC state');
	}
	return {
		provider: state.provider,
		state: state.state,
		verifier: state.verifier,
	};
}

function responseWithCookies(
	response: Response,
	...cookies: readonly string[]
): Response {
	const headers = new Headers(response.headers);
	for (const cookie of cookies) headers.append('set-cookie', cookie);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function oidcFailure(): AuthServiceError {
	return new AuthServiceError(
		'OIDC_AUTHENTICATION_FAILED',
		'External sign-in could not be completed.',
		401,
	);
}

async function readOidcJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (
		(Number.isFinite(declared) && declared > OIDC_RESPONSE_MAX_BYTES) ||
		!response.body
	)
		throw oidcFailure();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > OIDC_RESPONSE_MAX_BYTES) {
				await reader.cancel();
				throw oidcFailure();
			}
			chunks.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
	} catch (error) {
		if (error instanceof AuthServiceError) throw error;
		throw oidcFailure();
	}
}

function mfaChallengeCookie(
	token: string,
	secure: boolean,
	maxAge = 300,
): string {
	return `${MFA_CHALLENGE_COOKIE}=${encodeURIComponent(token)}; Path=/api/auth/mfa/challenge; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

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

/* Reset delivery remains non-enumerating even when throttled. The response is
   always the same accepted envelope; only the deployment mail adapter is
   skipped after the bounded email or trusted-address allowance is exhausted. */
function allowPasswordResetDelivery(
	context: Context,
	runtime: AuthRuntime,
	email: string,
): boolean {
	const emailAllowed = passwordResetEmailAttempts.consume(
		`reset:${normalizeEmail(email)}`,
	);
	const address = clientAddress(context.request, runtime.trustProxy);
	const addressAllowed =
		address === null ||
		passwordResetAddressAttempts.consume(`reset-address:${address}`);
	return emailAllowed && addressAllowed;
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
				signInProviders: runtime.settings.signInProviders.filter((id) =>
					runtime.oidcProviders.some((provider) => provider.id === id),
				),
				passwordMinLength: runtime.settings.passwordMinLength,
			}),
	});

	const oidcStart = new ServerRoute({
		path: '/api/auth/oidc/:provider/start',
		methods: ['GET'],
		handler: (context) => {
			try {
				const provider = runtime.oidcProviders.find(
					(entry) => entry.id === context.params.provider,
				);
				if (
					!provider ||
					!runtime.settings.signInProviders.includes(provider.id) ||
					!runtime.publicBaseUrl
				)
					throw new AuthServiceError(
						'OIDC_NOT_CONFIGURED',
						'This sign-in provider is not configured.',
						404,
					);
				const state = randomBytes(24).toString('base64url');
				const verifier = randomBytes(32).toString('base64url');
				const challenge = createHash('sha256')
					.update(verifier)
					.digest('base64url');
				const callback = `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${provider.id}/callback`;
				const authorization = new URL(provider.authorizationEndpoint);
				authorization.searchParams.set('response_type', 'code');
				authorization.searchParams.set('client_id', provider.clientId);
				authorization.searchParams.set('redirect_uri', callback);
				authorization.searchParams.set('scope', 'openid email profile');
				authorization.searchParams.set('state', state);
				authorization.searchParams.set('code_challenge', challenge);
				authorization.searchParams.set('code_challenge_method', 'S256');
				return new Response(null, {
					status: 302,
					headers: {
						location: authorization.toString(),
						'set-cookie': oidcStateCookie(
							sealOidcState(
								{ provider: provider.id, state, verifier },
								provider,
							),
							runtime.cookie.secure,
						),
					},
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const oidcCallback = new ServerRoute({
		path: '/api/auth/oidc/:provider/callback',
		methods: ['GET'],
		handler: async (context) => {
			const expiredState = oidcStateCookie('', runtime.cookie.secure, 0);
			try {
				const provider = runtime.oidcProviders.find(
					(entry) => entry.id === context.params.provider,
				);
				const callback = runtime.publicBaseUrl
					? `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${context.params.provider}/callback`
					: null;
				const url = new URL(context.request.url);
				const encoded = readCookie(context.request, OIDC_STATE_COOKIE);
				const code = url.searchParams.get('code');
				const submittedState = url.searchParams.get('state') ?? '';
				if (
					!provider ||
					!runtime.settings.signInProviders.includes(provider.id) ||
					!callback ||
					!encoded ||
					url.searchParams.get('error') ||
					!code ||
					code.length > 4_096 ||
					submittedState.length > 128
				)
					throw oidcFailure();
				let state: OidcState;
				try {
					state = openOidcState(encoded, provider);
				} catch {
					throw oidcFailure();
				}
				if (!safeEqual(state.state, submittedState)) throw oidcFailure();
				const tokenResponse = await fetch(provider.tokenEndpoint, {
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						accept: 'application/json',
					},
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code,
						redirect_uri: callback,
						client_id: provider.clientId,
						client_secret: provider.clientSecret,
						code_verifier: state.verifier,
					}),
					signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
				});
				if (!tokenResponse.ok) throw oidcFailure();
				const tokenBody = (await readOidcJson(tokenResponse)) as {
					access_token?: unknown;
				};
				if (
					typeof tokenBody.access_token !== 'string' ||
					tokenBody.access_token.length > 8192
				)
					throw oidcFailure();
				const profileResponse = await fetch(provider.userInfoEndpoint, {
					headers: {
						authorization: `Bearer ${tokenBody.access_token}`,
						accept: 'application/json',
					},
					signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
				});
				if (!profileResponse.ok) throw oidcFailure();
				const profile = (await readOidcJson(profileResponse)) as {
					email?: unknown;
					email_verified?: unknown;
				};
				if (
					typeof profile.email !== 'string' ||
					profile.email.length > 254 ||
					profile.email_verified !== true
				)
					throw oidcFailure();
				const issued = await (
					await runtime.service()
				).signInVerifiedExternalEmail(profile.email);
				if ('mfaRequired' in issued) {
					const headers = new Headers({ location: '/auth/mfa?mfa=oidc' });
					headers.append(
						'set-cookie',
						mfaChallengeCookie(issued.token, runtime.cookie.secure),
					);
					headers.append('set-cookie', expiredState);
					return new Response(null, { status: 302, headers });
				}
				const headers = new Headers({
					location: runtime.applicationPath ?? '/app',
				});
				headers.append(
					'set-cookie',
					sessionCookie(issued.token, runtime.cookie),
				);
				headers.append('set-cookie', expiredState);
				return new Response(null, { status: 302, headers });
			} catch (error) {
				return responseWithCookies(
					errorResponse(
						error instanceof AuthServiceError ? error : oidcFailure(),
					),
					expiredState,
				);
			}
		},
	});

	const workspaceAvailability = new ServerRoute({
		path: '/api/auth/workspace-availability',
		methods: ['GET'],
		handler: async (context) => {
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
				return response(
					await (await runtime.service()).checkWorkspaceSlug(slug),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const session = new ServerRoute({
		path: '/api/auth/session',
		methods: ['GET'],
		/* The shell polls this route. The authentication middleware already
		   resolved the session for this request, so reading it again would be a
		   second round trip for the same answer. */
		handler: (context) => {
			const current = sessionFromContext(context);
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
				const issued = await (await runtime.service()).signUp(input);
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
				const issued = await (
					await runtime.service()
				).signIn(input, { address: attempt.address });
				attempt.clear();
				if ('mfaRequired' in issued) {
					return response({
						mfaRequired: true,
						challengeToken: issued.token,
						expiresAt: issued.expiresAt,
					});
				}
				return response(sessionPayload(issued, runtime), 200, {
					'set-cookie': sessionCookie(issued.token, runtime.cookie),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const passwordResetRequest = new ServerRoute({
		path: '/api/auth/password-reset/request',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const email = stringField(body, 'email');
				if (email.length > 254)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'Enter a valid email address.',
						400,
					);
				if (allowPasswordResetDelivery(context, runtime, email)) {
					await (await runtime.service()).requestPasswordReset(email);
				}
				return response({ accepted: true }, 202);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const passwordResetComplete = new ServerRoute({
		path: '/api/auth/password-reset/complete',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const token = stringField(body, 'token');
				const password = stringField(body, 'password');
				if (token.length > 128 || password.length > 1024)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'The reset request is invalid.',
						400,
					);
				await (await runtime.service()).completePasswordReset(token, password);
				return response({ reset: true });
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const mfaChallenge = new ServerRoute({
		path: '/api/auth/mfa/challenge',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const token =
					typeof body.challengeToken === 'string' &&
					body.challengeToken.length > 0
						? body.challengeToken
						: (readCookie(context.request, MFA_CHALLENGE_COOKIE) ?? '');
				const code = typeof body.code === 'string' ? body.code : undefined;
				const recoveryCode =
					typeof body.recoveryCode === 'string' ? body.recoveryCode : undefined;
				if (
					token.length > 128 ||
					(code?.length ?? 0) > 16 ||
					(recoveryCode?.length ?? 0) > 32
				)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'The authentication request is invalid.',
						400,
					);
				const issued = await (
					await runtime.service()
				).completeMfaChallenge(token, code, recoveryCode);
				const headers = new Headers();
				headers.append(
					'set-cookie',
					sessionCookie(issued.token, runtime.cookie),
				);
				headers.append(
					'set-cookie',
					mfaChallengeCookie('', runtime.cookie.secure, 0),
				);
				return response(sessionPayload(issued, runtime), 200, headers);
			} catch (error) {
				return responseWithCookies(
					errorResponse(error),
					mfaChallengeCookie('', runtime.cookie.secure, 0),
				);
			}
		},
	});

	const mfaStatus = new ServerRoute({
		path: '/api/auth/mfa/status',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const session = requireSession(context);
				return response(
					await (
						await runtime.service()
					).mfaStatus(session.principal.accountId),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const mfaEnroll = new ServerRoute({
		path: '/api/auth/mfa/enroll',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				const body = await readJsonObject(context.request);
				const issuer =
					typeof body.issuer === 'string' && body.issuer.length <= 64
						? body.issuer
						: 'Flowdular';
				return response(
					await (
						await runtime.service()
					).enrollTotp(session.principal.accountId, issuer),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const mfaConfirm = new ServerRoute({
		path: '/api/auth/mfa/confirm',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				const body = await readJsonObject(context.request);
				const code = stringField(body, 'code');
				if (code.length > 16)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'The authentication code is invalid.',
						400,
					);
				await (
					await runtime.service()
				).confirmTotp(session.principal.accountId, code);
				return response({ confirmed: true });
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const createInvitation = new ServerRoute({
		path: '/api/auth/invitations',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, BUNDLED_MODULE_SCOPES.usersManage);
				const body = await readJsonObject(context.request);
				const email = stringField(body, 'email');
				const role = stringField(body, 'role');
				if (email.length > 254 || role.length > 32)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'The invitation is invalid.',
						400,
					);
				return response(
					{
						invitation: await (
							await runtime.service()
						).createTenantInvitation(actorOf(session), email, role),
					},
					201,
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const acceptInvitation = new ServerRoute({
		path: '/api/auth/invitations/accept',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const body = await readJsonObject(context.request);
				const token = stringField(body, 'token');
				const displayName = stringField(body, 'displayName');
				const password = stringField(body, 'password');
				if (
					token.length > 128 ||
					displayName.length > 80 ||
					password.length > 1024
				)
					throw new AuthServiceError(
						'INVALID_INPUT',
						'The invitation is invalid.',
						400,
					);
				await (
					await runtime.service()
				).acceptTenantInvitation({ token, displayName, password });
				return response({ accepted: true });
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const signOut = new ServerRoute({
		path: '/api/auth/sign-out',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context);
				const token = readCookie(context.request, runtime.cookie.name);
				const service = await runtime.service();
				const current = token ? await service.resolveSession(token) : null;
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
				await service.signOut(token);
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
				const service = await runtime.service();
				const current = token ? await service.resolveSession(token) : null;
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
				const issued = await service.switchTenant(token, tenantId);
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
				const service = await runtime.service();
				const session = token ? await service.resolveSession(token) : null;
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
				await service.changePassword({
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
				const session = requireSession(context);
				requireScope(session, PLATFORM_SCOPES.settingsManage);
				const body = await readJsonObject(context.request);
				return response({
					tenant: await (
						await runtime.service()
					).renameTenant(actorOf(session), stringField(body, 'name')),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	return [
		configuration,
		oidcStart,
		oidcCallback,
		changePassword,
		workspaceAvailability,
		session,
		signUp,
		signIn,
		passwordResetRequest,
		passwordResetComplete,
		mfaChallenge,
		mfaStatus,
		mfaEnroll,
		mfaConfirm,
		createInvitation,
		acceptInvitation,
		switchTenant,
		signOut,
		renameWorkspace,
		...createApiTokenRoutes(runtime),
		...createRoleRoutes(runtime),
		...createAuditRoutes(runtime),
		...createSessionRoutes(runtime),
	];
}
