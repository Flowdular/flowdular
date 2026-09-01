/* WRONG: the tenant id is read from the request body. */
import {
	defineEndpoint,
	jsonResponse,
	readJsonObject,
	requiredString,
} from '@coreloom/server';
import { endpointIdentityFromContext } from '@coreloom/module-auth/server';
import { CUSTOMER_PERMISSIONS } from '../acl/permissions.ts';
import type { CustomerRuntime } from '../server/runtime.ts';

export function createCustomerRoutes(runtime: CustomerRuntime) {
	const create = defineEndpoint({
		id: 'customers.records.create',
		path: '/api/customers',
		methods: ['POST'],
		access: { kind: 'permission', permission: CUSTOMER_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const value = await readJsonObject(octane.request);
			const tenantId = requiredString(value, 'tenantId');
			return jsonResponse(
				{
					customer: runtime
						.service()
						.create(tenantId, { name: requiredString(value, 'name') }),
				},
				201,
			);
		},
	});
	return [create.serverRoute] as const;
}
