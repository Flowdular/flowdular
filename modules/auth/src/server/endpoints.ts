import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
import { ServerRoute, type Context } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { BUNDLED_MODULE_SCOPES, PLATFORM_SCOPES } from '../acl/scopes.ts';
import type {
	SignInInput,
	SignInProviderOption,
	SignUpInput,
} from '../domain/types.ts';
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
import type { TenantProviderSignIn } from '../services/auth-service.ts';
import type { TenantSummary } from '../services/repository.ts';
import { normalizeEmail } from '../services/validation.ts';
import { createAuditRoutes } from './audit-endpoints.ts';
import { createMembershipRoutes } from './membership-endpoints.ts';
import { createIdentityProviderRoutes } from './provider-endpoints.ts';
import {
	actorOf,
	errorResponse,
	requireScope,
	requireSession,
	response,
	sessionPayload,
	stringField,
} from './http.ts';
import { oidcFailure, readOidcJson, OIDC_REQUEST_TIMEOUT_MS } from './oidc.ts';
import { assertProviderHostAllowed } from './provider-host.ts';
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
/* The sign-in screen resolves a workspace before it can offer its providers,
   and it does so for anonymous callers, so the lookup is bounded per workspace
   reference. One screen costs a handful of that workspace's allowance: the page
   load, the typed workspace, and the authorization round trip of every provider
   button that is pressed. */
const workspaceLookupAttempts = new AttemptLimiter(120, 60_000);
const passwordResetEmailAttempts = new AttemptLimiter(3, 15 * 60 * 1000);
const passwordResetAddressAttempts = new AttemptLimiter(20, 15 * 60 * 1000);
const MFA_CHALLENGE_COOKIE = 'coreloom_mfa_challenge';
const OIDC_STATE_COOKIE = 'coreloom_oidc_state';

interface OidcState {
	readonly provider: string;
	readonly state: string;
	readonly verifier: string;
	/* Bound into the same signed cookie as the state, so the ID token can only
	   be replayed into the browser transaction that asked for it. */
	readonly nonce: string;
	/* The workspace a tenant-owned provider signs into. A platform provider
	   names none, exactly as before. */
	readonly workspace?: string;
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
		!/^[A-Za-z0-9_-]{43}$/.test(state.verifier) ||
		typeof state.nonce !== 'string' ||
		!/^[A-Za-z0-9_-]{32}$/.test(state.nonce) ||
		(state.workspace !== undefined &&
			(typeof state.workspace !== 'string' || state.workspace.length > 128))
	) {
		throw new Error('invalid OIDC state');
	}
	return {
		provider: state.provider,
		state: state.state,
		verifier: state.verifier,
		nonce: state.nonce,
		...(state.workspace === undefined ? {} : { workspace: state.workspace }),
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
	/* A workspace id or slug arrives from an anonymous browser, so the lookup is
	   bounded and throttled before it reaches the database. */
	const workspaceOf = async (
		context: Context,
		reference: string,
	): Promise<TenantSummary | null> => {
		if (reference.length === 0 || reference.length > 128) return null;
		const address = clientAddress(context.request, runtime.trustProxy);
		/* Without a trusted proxy there is no client address, and a user-agent is
		   whatever the caller sends, so keying on one would put every anonymous
		   visitor in the same bucket. The workspace being asked for is the thing
		   worth bounding: one reference can be enumerated only at this rate, and
		   asking for another workspace never spends its allowance. */
		const bucket = reference.trim().toLowerCase();
		if (
			!workspaceLookupAttempts.consume(
				address === null
					? `workspace:${bucket}`
					: `workspace:${address}:${bucket}`,
			)
		) {
			throw new AuthServiceError('RATE_LIMITED', 'Try again later.', 429);
		}
		return (await runtime.service()).findTenant(reference);
	};

	/* Sign-in is routed by workspace, so the platform providers a deployment
	   offers everywhere and the workspace's own providers arrive as one list of
	   buttons, each carrying where it starts. */
	const signInProviderOptions = async (
		workspace: TenantSummary | null,
	): Promise<readonly SignInProviderOption[]> => {
		const platform = runtime.settings.signInProviders
			.filter((id) => runtime.oidcProviders.some((entry) => entry.id === id))
			.map(
				(id): SignInProviderOption => ({
					key: id,
					label: id,
					scope: 'platform',
					startPath: `/api/auth/oidc/${encodeURIComponent(id)}/start`,
				}),
			);
		if (!workspace) return platform;
		const owned = await (
			await runtime.service()
		).identityProviders.listEnabled(workspace.tenantId);
		return [
			...owned.map(
				(provider): SignInProviderOption => ({
					key: provider.key,
					label: provider.label,
					scope: 'tenant',
					startPath: `/api/auth/oidc/${encodeURIComponent(workspace.slug)}/${encodeURIComponent(provider.key)}/start`,
				}),
			),
			...platform,
		];
	};

	const configuration = new ServerRoute({
		path: '/api/auth/config',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const requested =
					new URL(context.request.url).searchParams.get('workspace') ?? '';
				/* An unknown workspace answers exactly as none at all: the password
				   form and the platform providers, and nothing that tells an
				   anonymous caller which workspace ids exist. */
				const workspace = requested
					? await workspaceOf(context, requested)
					: null;
				return response({
					allowSignUp: runtime.settings.allowSignUp,
					emailConfirmation: runtime.settings.emailConfirmation,
					signInProviders: runtime.settings.signInProviders.filter((id) =>
						runtime.oidcProviders.some((provider) => provider.id === id),
					),
					passwordMinLength: runtime.settings.passwordMinLength,
					workspace: workspace
						? { slug: workspace.slug, name: workspace.name }
						: null,
					providers: await signInProviderOptions(workspace),
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	const startAuthorization = (options: {
		readonly provider: OidcProvider;
		readonly callback: string;
		readonly scopes: readonly string[];
		readonly workspace?: string;
	}): Response => {
		const state = randomBytes(24).toString('base64url');
		const nonce = randomBytes(24).toString('base64url');
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const authorization = new URL(options.provider.authorizationEndpoint);
		authorization.searchParams.set('response_type', 'code');
		authorization.searchParams.set('client_id', options.provider.clientId);
		authorization.searchParams.set('redirect_uri', options.callback);
		authorization.searchParams.set('scope', options.scopes.join(' '));
		authorization.searchParams.set('state', state);
		authorization.searchParams.set('nonce', nonce);
		authorization.searchParams.set('code_challenge', challenge);
		authorization.searchParams.set('code_challenge_method', 'S256');
		return new Response(null, {
			status: 302,
			headers: {
				location: authorization.toString(),
				'set-cookie': oidcStateCookie(
					sealOidcState(
						{
							provider: options.provider.id,
							state,
							verifier,
							nonce,
							...(options.workspace === undefined
								? {}
								: { workspace: options.workspace }),
						},
						options.provider,
					),
					runtime.cookie.secure,
				),
			},
		});
	};

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
				return startAuthorization({
					provider,
					callback: `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${provider.id}/callback`,
					scopes: ['openid', 'email', 'profile'],
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	/**
	 * The workspace-routed authorization request. The key names a provider the
	 * workspace owns and offers; the signed state binds both, so a callback that
	 * arrives for another workspace or another provider is refused before
	 * anything is exchanged.
	 */
	const workspaceOidcStart = new ServerRoute({
		path: '/api/auth/oidc/:workspace/:key/start',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const workspace = await workspaceOf(
					context,
					context.params.workspace ?? '',
				);
				const resolved = workspace
					? await (
							await runtime.service()
						).identityProviders.resolveSignIn(
							workspace.tenantId,
							context.params.key ?? '',
						)
					: null;
				if (!resolved || !runtime.publicBaseUrl) {
					throw new AuthServiceError(
						'OIDC_NOT_CONFIGURED',
						'This sign-in provider is not configured.',
						404,
					);
				}
				return startAuthorization({
					provider: resolved.oidc,
					callback: `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${encodeURIComponent(context.params.workspace!)}/${encodeURIComponent(resolved.key)}/callback`,
					scopes: resolved.scopes,
					workspace: resolved.tenantId,
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	});

	/* Everything after the browser comes back: the state check, the exchange,
	   the verified token and the session. The platform route and the
	   workspace-routed one differ only in what they resolved beforehand. */
	const completeAuthorization = async (
		context: Context,
		options: {
			readonly provider: OidcProvider;
			readonly callback: string | null;
			/** The provider name the binding is stored under. */
			readonly binding: string;
			readonly workspace: TenantProviderSignIn | null;
		},
	): Promise<Response> => {
		const expiredState = oidcStateCookie('', runtime.cookie.secure, 0);
		try {
			const provider = options.provider;
			const callback = options.callback;
			const url = new URL(context.request.url);
			const encoded = readCookie(context.request, OIDC_STATE_COOKIE);
			const code = url.searchParams.get('code');
			const submittedState = url.searchParams.get('state') ?? '';
			if (
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
			/* The transaction names the workspace it started in. A state from
			   another workspace ends here, before the code is exchanged. */
			if ((state.workspace ?? null) !== (options.workspace?.tenantId ?? null))
				throw oidcFailure();
			/* The stored endpoints are guarded again here: a row written before the
			   guard existed, or a deployment provider configured by hand, must not
			   turn a sign-in into a request at the deployment's own network. An
			   anonymous caller learns nothing beyond the generic failure. */
			try {
				assertProviderHostAllowed(
					provider.tokenEndpoint,
					runtime.providerHosts,
					'tokenEndpoint',
				);
				assertProviderHostAllowed(
					provider.userInfoEndpoint,
					runtime.providerHosts,
					'userInfoEndpoint',
				);
			} catch {
				throw oidcFailure();
			}
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
				id_token?: unknown;
			};
			if (
				typeof tokenBody.access_token !== 'string' ||
				tokenBody.access_token.length > 8192 ||
				typeof tokenBody.id_token !== 'string'
			)
				throw oidcFailure();
			/* The ID token is what this server trusts. The access token only
			   fetches the profile, and the profile is accepted only for the
			   subject the signed token named. */
			const identity = await runtime.oidcVerifier.verifyIdToken(
				provider,
				tokenBody.id_token,
				state.nonce,
			);
			const profileResponse = await fetch(provider.userInfoEndpoint, {
				headers: {
					authorization: `Bearer ${tokenBody.access_token}`,
					accept: 'application/json',
				},
				signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
			});
			if (!profileResponse.ok) throw oidcFailure();
			const profile = (await readOidcJson(profileResponse)) as {
				sub?: unknown;
				email?: unknown;
				email_verified?: unknown;
			};
			if (
				typeof profile.email !== 'string' ||
				profile.email.length > 254 ||
				profile.email_verified !== true ||
				(profile.sub !== undefined &&
					(typeof profile.sub !== 'string' ||
						!safeEqual(profile.sub, identity.subject)))
			)
				throw oidcFailure();
			/* How the account lookup ended is not something an external caller
			   may tell apart from a token this server refused. */
			const issued = await (
				await runtime.service()
			)
				.signInExternalIdentity({
					provider: options.binding,
					subject: identity.subject,
					email: profile.email,
					...(options.workspace ? { workspace: options.workspace } : {}),
				})
				.catch(() => {
					throw oidcFailure();
				});
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
			headers.append('set-cookie', sessionCookie(issued.token, runtime.cookie));
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
	};

	const oidcCallback = new ServerRoute({
		path: '/api/auth/oidc/:provider/callback',
		methods: ['GET'],
		handler: async (context) => {
			const provider = runtime.oidcProviders.find(
				(entry) => entry.id === context.params.provider,
			);
			if (
				!provider ||
				!runtime.settings.signInProviders.includes(provider.id) ||
				!runtime.publicBaseUrl
			) {
				return responseWithCookies(
					errorResponse(oidcFailure()),
					oidcStateCookie('', runtime.cookie.secure, 0),
				);
			}
			return completeAuthorization(context, {
				provider,
				callback: `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${context.params.provider}/callback`,
				binding: provider.id,
				workspace: null,
			});
		},
	});

	const workspaceOidcCallback = new ServerRoute({
		path: '/api/auth/oidc/:workspace/:key/callback',
		methods: ['GET'],
		handler: async (context) => {
			const expiredState = oidcStateCookie('', runtime.cookie.secure, 0);
			try {
				const workspace = await workspaceOf(
					context,
					context.params.workspace ?? '',
				);
				const resolved = workspace
					? await (
							await runtime.service()
						).identityProviders.resolveSignIn(
							workspace.tenantId,
							context.params.key ?? '',
						)
					: null;
				if (!resolved || !runtime.publicBaseUrl) throw oidcFailure();
				return await completeAuthorization(context, {
					provider: resolved.oidc,
					callback: `${runtime.publicBaseUrl.replace(/\/$/, '')}/api/auth/oidc/${encodeURIComponent(context.params.workspace!)}/${encodeURIComponent(resolved.key)}/callback`,
					binding: resolved.key,
					workspace: {
						tenantId: resolved.tenantId,
						jitEnabled: resolved.jitEnabled,
						allowedDomains: resolved.allowedDomains,
						jitRole: resolved.jitRole,
					},
				});
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
				/* The screen sends the workspace it is on. An empty field is the
				   same request the screen made before workspaces were routed. */
				const workspace =
					body.workspace === undefined
						? ''
						: stringField(body, 'workspace').trim();
				const input: SignInInput = {
					email: stringField(body, 'email'),
					password: stringField(body, 'password'),
					...(workspace === '' ? {} : { workspace }),
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
				const [status, tenant] = await Promise.all([
					(await runtime.service()).mfaStatus(session.principal.accountId),
					runtime.tenantSettings(session.principal.tenantId),
				]);
				return response({ ...status, required: tenant.requireMfa });
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

	/* Administrative clearing of a lost factor. It lives beside the enrolment
	   routes because the factor is auth.core's, and it answers to the member
	   management scope because that is who administers members. */
	const mfaReset = new ServerRoute({
		path: '/api/auth/mfa/reset',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, BUNDLED_MODULE_SCOPES.usersManage);
				const body = await readJsonObject(context.request);
				const accountId = stringField(body, 'accountId');
				if (accountId.length === 0 || accountId.length > 128) {
					throw new AuthServiceError(
						'INVALID_INPUT',
						'accountId is invalid.',
						400,
					);
				}
				await (
					await runtime.service()
				).resetMemberMfa(actorOf(session), accountId);
				return response({ reset: true });
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
		workspaceOidcStart,
		workspaceOidcCallback,
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
		mfaReset,
		createInvitation,
		acceptInvitation,
		switchTenant,
		signOut,
		renameWorkspace,
		...createApiTokenRoutes(runtime),
		...createRoleRoutes(runtime),
		...createAuditRoutes(runtime),
		...createSessionRoutes(runtime),
		...createIdentityProviderRoutes(runtime),
		...createMembershipRoutes(runtime),
	];
}
