import {
	defineEndpoint,
	jsonResponse,
	problemResponse,
} from '@flowdular/server';
import type { AuthPrincipal } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
} from '@flowdular/module-auth/server';
import { REPORTS_PERMISSIONS } from '../acl/permissions.ts';
import type { ReportsRuntime } from '../server/runtime.ts';
import { readReportRange } from '../services/range.ts';
import { ReportsServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof ReportsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The reports operation failed.');
}

function reportPrincipal(principal: AuthPrincipal) {
	return {
		accountId: principal.accountId,
		tenantId: principal.tenantId,
		scopes: principal.scopes,
	};
}

export function createReportsRoutes(
	_auth: AuthRuntime,
	runtime: ReportsRuntime,
) {
	/* A read: no body, no CSRF token and no tenant identifier from the request.
	   The principal the endpoint resolved is the only tenant authority. */
	const read = defineEndpoint({
		id: 'reports.workspace.read',
		path: '/api/reports',
		methods: ['GET'],
		access: { kind: 'permission', permission: REPORTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const url = new URL(octane.request.url);
				return jsonResponse(
					await runtime.service().read({
						principal: reportPrincipal(principal),
						range: readReportRange(
							{
								from: url.searchParams.get('from'),
								to: url.searchParams.get('to'),
							},
							Date.now(),
						),
					}),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [read.serverRoute] as const;
}

export const endpoints = ['reports.workspace.read'] as const;
