import { defineEndpoint } from '@flowdular/sdk/server';
import type { ConfiguredDatabaseProvider } from '@flowdular/sdk/database';

/* Liveness only: it proves the process answers and touches nothing else, so a
   container probe never fails because the database is busy. */
export const healthEndpoint = defineEndpoint({
	id: 'system.health',
	path: '/api/health',
	methods: ['GET'],
	access: { kind: 'public' },
	handler: ({ requestId }) =>
		Response.json(
			{ status: 'ok', service: 'flowdular', requestId },
			{ headers: { 'cache-control': 'no-store' } },
		),
});

export function createReadinessEndpoint(databases: ConfiguredDatabaseProvider) {
	return defineEndpoint({
		id: 'system.ready',
		path: '/api/ready',
		methods: ['GET'],
		access: { kind: 'public' },
		handler: async ({ requestId }) => {
			try {
				const database = await databases.check();
				return Response.json(
					{ status: 'ready', service: 'flowdular', requestId, database },
					{ headers: { 'cache-control': 'no-store' } },
				);
			} catch {
				return Response.json(
					{
						status: 'unavailable',
						service: 'flowdular',
						requestId,
						database: { adapter: databases.adapter, status: 'unavailable' },
					},
					{
						status: 503,
						headers: { 'cache-control': 'no-store', 'retry-after': '1' },
					},
				);
			}
		},
	});
}
