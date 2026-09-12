import { ServerRoute } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { BUNDLED_MODULE_SCOPES } from '../acl/scopes.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import {
	actorOf,
	errorResponse,
	requireScope,
	requireSession,
	response,
	stringField,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

/**
 * The administration port users.core calls to disable or re-enable a member of
 * the acting workspace. The workspace comes from the principal, so a target in
 * another workspace answers exactly as an unknown account.
 */
export function createMembershipRoutes(
	runtime: AuthRuntime,
): readonly ServerRoute[] {
	const status = new ServerRoute({
		path: '/api/auth/memberships/status',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, BUNDLED_MODULE_SCOPES.usersManage);
				const body = await readJsonObject(context.request);
				const accountId = stringField(body, 'accountId');
				const value = stringField(body, 'status');
				if (accountId.length === 0 || accountId.length > 128) {
					throw new AuthServiceError(
						'INVALID_INPUT',
						'accountId is invalid.',
						400,
					);
				}
				if (value !== 'active' && value !== 'disabled') {
					throw new AuthServiceError(
						'INVALID_INPUT',
						'status must be active or disabled.',
						400,
					);
				}
				return response({
					membership: await (
						await runtime.service()
					).setMembershipStatus(actorOf(session), accountId, value),
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] membership request failed');
			}
		},
	});

	return [status];
}
