/* WRONG: a raw ServerRoute with no permission and no identity resolver. */
import { ServerRoute } from '@octanejs/app-core';
import type { CustomerRuntime } from '../server/runtime.ts';

export function createCustomerRoutes(runtime: CustomerRuntime) {
	const list = new ServerRoute({
		path: '/api/customers',
		methods: ['GET'],
		handler: () => Response.json({ customers: runtime.service().listAll() }),
	});
	return [list] as const;
}
