import { defineEndpoint } from '@flowdular/server';
import type { PlatformDatabaseProvider } from './database.ts';

/* Built per generation rather than at import: the endpoint catalogue the API
   document is written from is cleared when a generation starts composing, and
   an endpoint defined at import time would be recorded before that. */
export function createHealthEndpoint() {
	return defineEndpoint({
		id: 'system.health',
		path: '/api/health',
		methods: ['GET'],
		access: { kind: 'public' },
		documentation: {
			summary: 'Answer whether the process is serving',
			description:
				'Open to an unauthenticated caller and answers for the process alone; readiness of the database is /api/ready.',
			responses: [{ status: 200, description: 'The process is serving.' }],
		},
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
}

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
