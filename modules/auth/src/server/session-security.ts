import { timingSafeEqual } from 'node:crypto';
import type { Context } from '@octanejs/app-core';
import {
	isTokenPrincipal,
	sessionFromContext,
	tokenWritesAllowed,
} from '../middleware/authentication.ts';
import { assertSameOrigin } from '../api/origin.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import type { AuthRuntime } from './runtime.ts';

function equal(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

function denial(status: number, code: string, message: string): Response {
	return Response.json(
		{ error: { code, message } },
		{ status, headers: { 'cache-control': 'no-store' } },
	);
}

/**
 * The guard every module mutation runs first. It admits two callers and no
 * others: a browser session that proves the request is its own with a same
 * origin and a CSRF token, and an API token the workspace issued with writes
 * allowed. The same-origin and CSRF checks are defences against a browser
 * being made to act for its user, so they do not apply to a bearer credential,
 * which is bound instead by the permission its workspace granted it and by the
 * origins it may be presented from.
 *
 * The session comes from the authentication middleware, which resolved it once
 * for this request. That is what keeps this guard synchronous for the modules
 * that call it at the head of every mutation, now that reading a session is a
 * database round trip.
 *
 * The runtime argument is accepted and ignored so those call sites keep
 * compiling; new ones may omit it, and it can be dropped once none pass it.
 */
export function sessionMutationDenial(
	context: Context,
	_runtime?: AuthRuntime,
): Response | null {
	try {
		if (isTokenPrincipal(context)) {
			return tokenWritesAllowed(context)
				? null
				: denial(
						403,
						'TOKEN_MUTATION_DENIED',
						'This API token was not issued with permission to write.',
					);
		}
		assertSameOrigin(context);
		const session = sessionFromContext(context);
		if (!session) {
			return denial(401, 'UNAUTHENTICATED', 'Authentication is required.');
		}
		const submitted = context.request.headers.get('x-csrf-token') ?? '';
		return equal(submitted, session.csrfToken)
			? null
			: denial(403, 'CSRF_REJECTED', 'CSRF token is invalid.');
	} catch (error) {
		return error instanceof AuthServiceError
			? denial(error.status, error.code, error.message)
			: denial(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
	}
}

/**
 * The stricter guard, for a mutation that shapes who may reach the workspace
 * at all: credentials, memberships, roles, identity providers and sessions. A
 * machine credential is refused there whatever it was issued with, so a token
 * can never widen its own access or mint another.
 */
export function browserSessionMutationDenial(
	context: Context,
	_runtime?: AuthRuntime,
): Response | null {
	if (isTokenPrincipal(context)) {
		return denial(
			403,
			'TOKEN_MUTATION_DENIED',
			'An API token cannot perform a session-guarded mutation.',
		);
	}
	return sessionMutationDenial(context);
}
