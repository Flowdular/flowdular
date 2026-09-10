import { ServerRoute } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { AUTH_SCOPES } from '../acl/scopes.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import {
	errorResponse,
	requireScope,
	requireSession,
	response,
	scopeList,
	stringField,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

function expiry(body: Record<string, unknown>): number | null {
	const value = body.expiresAt;
	if (value === undefined || value === null) return null;
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new AuthServiceError(
			'INVALID_EXPIRY',
			'expiresAt must be an integer timestamp in milliseconds.',
			400,
		);
	}
	return value;
}

/* Token management is a browser-session operation. A machine credential can
   never mint or revoke another credential. */
export function createApiTokenRoutes(
	runtime: AuthRuntime,
): readonly ServerRoute[] {
	const list = new ServerRoute({
		path: '/api/auth/api-tokens',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.tokensRead);
				return response({
					tokens: await (
						await runtime.service()
					).listApiTokens(session.principal.tenantId),
					availableScopes: session.principal.scopes,
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] api token request failed');
			}
		},
	});

	const create = new ServerRoute({
		path: '/api/auth/api-tokens',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.tokensManage);
				const body = await readJsonObject(context.request);
				const issued = await (
					await runtime.service()
				).issueApiToken({
					tenantId: session.principal.tenantId,
					accountId: session.principal.accountId,
					label: stringField(body, 'label'),
					scopes: scopeList(body),
					expiresAt: expiry(body),
					createdBy: session.principal.accountId,
				});
				return response(issued, 201);
			} catch (error) {
				return errorResponse(error, '[auth.core] api token request failed');
			}
		},
	});

	const revoke = new ServerRoute({
		path: '/api/auth/api-tokens/revoke',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.tokensManage);
				const body = await readJsonObject(context.request);
				return response({
					token: await (
						await runtime.service()
					).revokeApiToken(
						session.principal.tenantId,
						stringField(body, 'id'),
						session.principal.accountId,
					),
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] api token request failed');
			}
		},
	});

	return [list, create, revoke];
}
