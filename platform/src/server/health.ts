import { defineEndpoint } from '@flowdular/server';
import type { PlatformDatabaseProvider } from './database.ts';

export const healthEndpoint = defineEndpoint({
	id: 'system.health',
	path: '/api/health',
	methods: ['GET'],
	access: { kind: 'public' },
	handler: ({ requestId }) =>
		Response.json(
			{
				status: 'ok',
				service: 'flowdular',
				architectureVersion: '0.2.0',
				requestId,
			},
			{ headers: { 'cache-control': 'no-store' } },
		),
});

export function createReadinessEndpoint(databases: PlatformDatabaseProvider) {
	return defineEndpoint({
		id: 'system.ready',
		path: '/api/ready',
		methods: ['GET'],
		access: { kind: 'public' },
		handler: async ({ requestId }) => {
			try {
				const database = await databases.check();
				return Response.json(
					{
						status: 'ready',
						service: 'flowdular',
						requestId,
						database,
					},
					{ headers: { 'cache-control': 'no-store' } },
				);
			} catch {
				return Response.json(
					{
						status: 'unavailable',
						service: 'flowdular',
						requestId,
						database: {
							adapter: databases.adapter,
							status: 'unavailable',
						},
					},
					{
						status: 503,
						headers: {
							'cache-control': 'no-store',
							'retry-after': '1',
						},
					},
				);
			}
		},
	});
}
