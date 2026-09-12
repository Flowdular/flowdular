import {
	defineEndpoint,
	jsonResponse,
	problemResponse,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
} from '@flowdular/module-auth/server';
import { METERING_PERMISSIONS } from '../acl/permissions.ts';
import type { MeteringRuntime } from '../server/runtime.ts';
import { MeteringServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof MeteringServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The metering operation failed.');
}

/* Every route is a read. Limits are the operator's, so this module publishes no
   mutation a workspace could reach, and there is no CSRF surface to guard. */
export function createMeteringRoutes(
	_auth: AuthRuntime,
	runtime: MeteringRuntime,
) {
	const meters = defineEndpoint({
		id: 'metering.meters.list',
		path: '/api/metering/meters',
		methods: ['GET'],
		access: { kind: 'permission', permission: METERING_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					meters: await service.usage(principalFromContext(octane)!.tenantId),
					warningPercent: service.warningPercent(),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const buckets = defineEndpoint({
		id: 'metering.buckets.list',
		path: '/api/metering/buckets',
		methods: ['GET'],
		access: { kind: 'permission', permission: METERING_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const meter = url.searchParams.get('meter');
				if (meter === null || meter === '') {
					throw new MeteringServiceError('INVALID_INPUT', 'meter is required.');
				}
				const from = url.searchParams.get('from');
				const to = url.searchParams.get('to');
				const service = await runtime.service();
				return jsonResponse({
					buckets: await service.buckets(
						principalFromContext(octane)!.tenantId,
						{
							meter,
							...(from ? { from } : {}),
							...(to ? { to } : {}),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const limits = defineEndpoint({
		id: 'metering.limits.list',
		path: '/api/metering/limits',
		methods: ['GET'],
		access: { kind: 'permission', permission: METERING_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				return jsonResponse({
					limits: await service.limits(principalFromContext(octane)!.tenantId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [meters.serverRoute, buckets.serverRoute, limits.serverRoute] as const;
}

export const endpoints = [
	'metering.meters.list',
	'metering.buckets.list',
	'metering.limits.list',
] as const;
