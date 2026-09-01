import { ServerRoute } from '@octanejs/app-core';
import { readJsonObject } from '@coreloom/server';
import { AUTH_SCOPES } from '../acl/scopes.ts';
import {
	actorOf,
	errorResponse,
	optionalStringField,
	requireScope,
	requireSession,
	response,
	scopeList,
	stringField,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

export function createRoleRoutes(runtime: AuthRuntime): readonly ServerRoute[] {
	const list = new ServerRoute({
		path: '/api/auth/roles',
		methods: ['GET'],
		handler: (context) => {
			try {
				const session = requireSession(context, runtime);
				requireScope(session, AUTH_SCOPES.rolesRead);
				const service = runtime.service();
				return response({
					roles: service.listRoles(session.principal.tenantId),
					grantableScopes: service.listGrantableScopes(
						session.principal.tenantId,
					),
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] roles request failed');
			}
		},
	});

	const create = new ServerRoute({
		path: '/api/auth/roles',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context, runtime);
				requireScope(session, AUTH_SCOPES.rolesManage);
				const body = await readJsonObject(context.request);
				const actor = actorOf(session);
				return response(
					{
						role: runtime.service().createRole(actor, {
							tenantId: actor.tenantId,
							key: stringField(body, 'key'),
							name: stringField(body, 'name'),
							description: optionalStringField(body, 'description') ?? '',
							scopes: scopeList(body),
						}),
					},
					201,
				);
			} catch (error) {
				return errorResponse(error, '[auth.core] roles request failed');
			}
		},
	});

	const update = new ServerRoute({
		path: '/api/auth/roles/update',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context, runtime);
				requireScope(session, AUTH_SCOPES.rolesManage);
				const body = await readJsonObject(context.request);
				const actor = actorOf(session);
				const name = optionalStringField(body, 'name');
				const description = optionalStringField(body, 'description');
				return response({
					role: runtime.service().updateRole(actor, {
						tenantId: actor.tenantId,
						id: stringField(body, 'id'),
						...(name === undefined ? {} : { name }),
						...(description === undefined ? {} : { description }),
						...(body.scopes === undefined ? {} : { scopes: scopeList(body) }),
					}),
				});
			} catch (error) {
				return errorResponse(error, '[auth.core] roles request failed');
			}
		},
	});

	const remove = new ServerRoute({
		path: '/api/auth/roles/delete',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context, runtime);
				requireScope(session, AUTH_SCOPES.rolesManage);
				const body = await readJsonObject(context.request);
				runtime.service().deleteRole(actorOf(session), stringField(body, 'id'));
				return response({ deleted: true });
			} catch (error) {
				return errorResponse(error, '[auth.core] roles request failed');
			}
		},
	});

	return [list, create, update, remove];
}
