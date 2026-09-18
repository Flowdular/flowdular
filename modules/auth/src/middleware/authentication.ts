import type { Context, Middleware } from '@octanejs/app-core';
import type { EndpointIdentity } from '@flowdular/server';
import type { AuthPrincipal, AuthSession } from '../domain/types.ts';
import { readCookie, type AuthCookieConfig } from '../api/cookies.ts';
import type { AuthService } from '../services/auth-service.ts';

export const AUTH_PRINCIPAL_STATE_KEY = 'flowdular.auth.principal';
/* Set when the principal came from an API token instead of a browser session.
   A machine credential carries no CSRF proof, so a mutation it attempts is
   admitted by the token's own write permission instead. */
export const AUTH_TOKEN_PRINCIPAL_STATE_KEY = 'flowdular.auth.token-principal';
/* Set with it: whether the workspace issued the token with writes allowed. */
export const AUTH_TOKEN_WRITES_STATE_KEY = 'flowdular.auth.token-writes';
/* The whole browser session, set only when a cookie resolved one. Reading the
   session is a database round trip, and the CSRF check, the session guard and
   auth's own routes all need it, so the middleware resolves it once and
   publishes it here. It is also what keeps those callers synchronous. */
export const AUTH_SESSION_STATE_KEY = 'flowdular.auth.session';

type ServiceResolver = () => Promise<AuthService>;

export function createAuthenticationMiddleware(
	service: ServiceResolver,
	cookie: AuthCookieConfig,
	/** Loads the principal's workspace settings before any route reads them. */
	primeTenant?: (tenantId: string) => Promise<void>,
): Middleware {
	return async (context, next) => {
		const token = readCookie(context.request, cookie.name);
		const resolved = await service();
		const session = token ? await resolved.resolveSession(token) : null;
		if (session) {
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, session.principal);
			context.state.set(AUTH_SESSION_STATE_KEY, session);
			await primeTenant?.(session.principal.tenantId);
			return next();
		}
		const identity = await resolved.resolveApiTokenIdentity(
			bearerToken(context.request.headers.get('authorization')),
		);
		if (identity) {
			/* A token bound to browser origins is refused from anywhere else, so
			   a credential lifted from one site cannot be replayed from another.
			   A server-side caller sends no Origin header and is unaffected. */
			const origin = crossOrigin(context);
			if (origin && !identity.allowedOrigins.includes(origin)) {
				return denial(
					403,
					'TOKEN_ORIGIN_DENIED',
					'This API token may not be presented from this origin.',
				);
			}
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, identity.principal);
			context.state.set(AUTH_TOKEN_PRINCIPAL_STATE_KEY, true);
			context.state.set(AUTH_TOKEN_WRITES_STATE_KEY, identity.allowWrites);
			await primeTenant?.(identity.principal.tenantId);
		}
		return next();
	};
}

function bearerToken(header: string | null): string | null {
	if (!header) return null;
	const [scheme, value] = header.split(' ');
	return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/** The request's origin when it differs from the address it was sent to. */
function crossOrigin(context: Context): string | null {
	const origin = context.request.headers.get('origin')?.toLowerCase() ?? null;
	return origin && origin !== context.url.origin.toLowerCase() ? origin : null;
}

export function isTokenPrincipal(context: Context): boolean {
	return context.state.get(AUTH_TOKEN_PRINCIPAL_STATE_KEY) === true;
}

/** Whether the API token this request carries was issued with writes allowed. */
export function tokenWritesAllowed(context: Context): boolean {
	return context.state.get(AUTH_TOKEN_WRITES_STATE_KEY) === true;
}

/** The browser session the middleware resolved, or null for any other caller. */
export function sessionFromContext(context: Context): AuthSession | null {
	const value = context.state.get(AUTH_SESSION_STATE_KEY);
	return value && typeof value === 'object' ? (value as AuthSession) : null;
}

export function principalFromContext(context: Context): AuthPrincipal | null {
	const value = context.state.get(AUTH_PRINCIPAL_STATE_KEY);
	return value && typeof value === 'object' ? (value as AuthPrincipal) : null;
}

export function endpointIdentityFromContext(
	context: Context,
): EndpointIdentity | null {
	const principal = principalFromContext(context);
	return principal
		? {
				subjectId: principal.accountId,
				tenantId: principal.tenantId,
				permissions: new Set(principal.scopes),
			}
		: null;
}

function denial(status: number, code: string, message: string): Response {
	return Response.json(
		{ error: { code, message } },
		{ status, headers: { 'cache-control': 'no-store' } },
	);
}

export function requireAuthentication(): Middleware {
	return (context, next) =>
		principalFromContext(context)
			? next()
			: denial(401, 'UNAUTHENTICATED', 'Authentication is required.');
}

export function requireScopes(...required: readonly string[]): Middleware {
	return (context, next) => {
		const principal = principalFromContext(context);
		if (!principal)
			return denial(401, 'UNAUTHENTICATED', 'Authentication is required.');
		const granted = new Set(principal.scopes);
		return required.every((scope) => granted.has(scope))
			? next()
			: denial(403, 'FORBIDDEN', 'The required scope was not granted.');
	};
}
