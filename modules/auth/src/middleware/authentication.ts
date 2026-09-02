import type { Context, Middleware } from '@octanejs/app-core';
import type { EndpointIdentity } from '@coreloom/server';
import type { AuthPrincipal } from '../domain/types.ts';
import { readCookie, type AuthCookieConfig } from '../api/cookies.ts';
import type { AuthService } from '../services/auth-service.ts';

export const AUTH_PRINCIPAL_STATE_KEY = 'coreloom.auth.principal';
/* Set when the principal came from an API token instead of a browser session.
   Session-guarded mutations stay closed to machine credentials. */
export const AUTH_TOKEN_PRINCIPAL_STATE_KEY = 'coreloom.auth.token-principal';

type ServiceResolver = () => AuthService;

export function createAuthenticationMiddleware(
	service: ServiceResolver,
	cookie: AuthCookieConfig,
): Middleware {
	return async (context, next) => {
		const token = readCookie(context.request, cookie.name);
		const session = token ? service().resolveSession(token) : null;
		if (session) {
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, session.principal);
			return next();
		}
		const principal = service().resolveApiToken(
			bearerToken(context.request.headers.get('authorization')),
		);
		if (principal) {
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, principal);
			context.state.set(AUTH_TOKEN_PRINCIPAL_STATE_KEY, true);
		}
		return next();
	};
}

function bearerToken(header: string | null): string | null {
	if (!header) return null;
	const [scheme, value] = header.split(' ');
	return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

export function isTokenPrincipal(context: Context): boolean {
	return context.state.get(AUTH_TOKEN_PRINCIPAL_STATE_KEY) === true;
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
		? { subjectId: principal.accountId, permissions: new Set(principal.scopes) }
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
