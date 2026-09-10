import type { Context } from '@octanejs/app-core';
import { ModuleSettingsError } from '@flowdular/kernel';
import { HttpProblem } from '@flowdular/server';
import type { AuthActor, AuthSession } from '../domain/types.ts';
import { sessionFromContext } from '../middleware/authentication.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import type { AuthRuntime } from './runtime.ts';

export function response(
	body: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response {
	const responseHeaders = new Headers(headers);
	if (!responseHeaders.has('cache-control')) {
		responseHeaders.set('cache-control', 'no-store');
	}
	return Response.json(body, {
		status,
		headers: responseHeaders,
	});
}

export function errorResponse(
	error: unknown,
	label = '[auth.core] request failed',
): Response {
	if (
		error instanceof AuthServiceError ||
		error instanceof HttpProblem ||
		error instanceof ModuleSettingsError
	) {
		return response(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	/* Repository and provider errors can contain bound values or credentials.
	   The public response and the server log both stay free of the raw value. */
	console.error(`${label} (${error instanceof Error ? 'Error' : 'non-error'})`);
	return response(
		{
			error: {
				code: 'INTERNAL_ERROR',
				message: 'The request could not be completed.',
			},
		},
		500,
	);
}

export function stringField(
	body: Record<string, unknown>,
	key: string,
): string {
	const value = body[key];
	if (typeof value !== 'string') {
		throw new AuthServiceError(
			'INVALID_INPUT',
			`${key} must be a string.`,
			400,
		);
	}
	return value;
}

export function optionalStringField(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	return stringField(body, key);
}

export function scopeList(
	body: Record<string, unknown>,
	key = 'scopes',
): readonly string[] {
	const value = body[key];
	if (
		!Array.isArray(value) ||
		value.length > 256 ||
		value.some((entry) => typeof entry !== 'string')
	) {
		throw new AuthServiceError(
			'INVALID_SCOPES',
			`${key} must be an array of scope identifiers.`,
			400,
		);
	}
	return value as readonly string[];
}

/* Browser-session identity for auth's own routes. API tokens are resolved by
   the middleware for module endpoints, but auth administration stays a
   session-only surface. */
export function requireSession(context: Context): AuthSession {
	const session = sessionFromContext(context);
	if (!session) {
		throw new AuthServiceError(
			'UNAUTHENTICATED',
			'Authentication is required.',
			401,
		);
	}
	return session;
}

export function requireScope(session: AuthSession, scope: string): void {
	if (!session.principal.scopes.includes(scope)) {
		throw new AuthServiceError(
			'FORBIDDEN',
			'The required scope was not granted.',
			403,
		);
	}
}

export function actorOf(session: AuthSession): AuthActor {
	return {
		accountId: session.principal.accountId,
		tenantId: session.principal.tenantId,
		email: session.principal.email,
		role: session.principal.role,
		scopes: session.principal.scopes,
	};
}

export function sessionPayload(
	session: AuthSession,
	runtime: AuthRuntime,
): Record<string, unknown> {
	return {
		principal: session.principal,
		csrfToken: session.csrfToken,
		expiresAt: session.expiresAt,
		sessionId: session.sessionId,
		passwordChangeRequired: session.passwordChangeRequired,
		tenantSettings: runtime.moduleSettings
			.list(session.principal.tenantId)
			.filter(
				(entry) =>
					entry.moduleId === 'auth.core' &&
					entry.definition.scope === 'tenant' &&
					entry.definition.client,
			)
			.reduce<Record<string, unknown>>((snapshot, entry) => {
				snapshot[entry.key] = entry.value;
				return snapshot;
			}, {}),
	};
}
