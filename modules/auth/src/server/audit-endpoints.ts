import { ServerRoute } from '@octanejs/app-core';
import { AUTH_SCOPES } from '../acl/scopes.ts';
import { AUDIT_ACTION_LIST } from '../services/auth-service.ts';
import {
	errorResponse,
	requireScope,
	requireSession,
	response,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';

const DEFAULT_PAGE = 50;

function queryString(
	search: URLSearchParams,
	key: string,
	max: number,
): string | null {
	const value = search.get(key)?.trim() ?? '';
	return value.length > 0 && value.length <= max ? value : null;
}

export function createAuditRoutes(
	runtime: AuthRuntime,
): readonly ServerRoute[] {
	const list = new ServerRoute({
		path: '/api/auth/audit',
		methods: ['GET'],
		handler: (context) => {
			try {
				const session = requireSession(context, runtime);
				requireScope(session, AUTH_SCOPES.auditRead);
				const search = new URL(context.request.url).searchParams;
				const limit = Number(search.get('limit') ?? DEFAULT_PAGE);
				const page = runtime.service().queryAudit({
					tenantId: session.principal.tenantId,
					action: queryString(search, 'action', 64),
					actor: queryString(search, 'actor', 254),
					cursor: queryString(search, 'cursor', 64),
					limit: Number.isSafeInteger(limit) ? limit : DEFAULT_PAGE,
				});
				return response({ ...page, actions: AUDIT_ACTION_LIST });
			} catch (error) {
				return errorResponse(error, '[auth.core] audit request failed');
			}
		},
	});
	return [list];
}
