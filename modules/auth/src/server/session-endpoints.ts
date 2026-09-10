import { ServerRoute } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { BUNDLED_MODULE_SCOPES } from '../acl/scopes.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import {
	actorOf,
	errorResponse,
	optionalStringField,
	requireScope,
	requireSession,
	response,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

export function createSessionRoutes(
	runtime: AuthRuntime,
): readonly ServerRoute[] {
	const list = new ServerRoute({
		path: '/api/auth/sessions',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const session = requireSession(context);
				return response({
					currentSessionId: session.sessionId,
					sessions: (
						await (
							await runtime.service()
						).listSessions(session.principal.accountId)
					).map((entry) => ({
						...entry,
						current: entry.id === session.sessionId,
					})),
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] sessions request failed');
			}
		},
	});

	/* `id` revokes one of the caller's own sessions; `accountId` lets a member
	   administrator sign another member out everywhere. */
	const revoke = new ServerRoute({
		path: '/api/auth/sessions/revoke',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				const body = await readJsonObject(context.request);
				const id = optionalStringField(body, 'id');
				const accountId = optionalStringField(body, 'accountId');
				if (accountId !== undefined) {
					requireScope(session, BUNDLED_MODULE_SCOPES.usersManage);
					return response({
						revoked: await (
							await runtime.service()
						).revokeMemberSessions(actorOf(session), accountId),
					});
				}
				if (id === undefined) {
					throw new AuthServiceError(
						'INVALID_INPUT',
						'Provide a session id or an account id.',
						400,
					);
				}
				if (id === session.sessionId) {
					throw new AuthServiceError(
						'CURRENT_SESSION',
						'Sign out to end the current session.',
						400,
					);
				}
				await (await runtime.service()).revokeOwnSession(session, id);
				return response({ revoked: 1 });
			} catch (error) {
				return errorResponse(error, '[auth.core] sessions request failed');
			}
		},
	});

	return [list, revoke];
}
