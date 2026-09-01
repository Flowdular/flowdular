import { defineEndpoint } from '@coreloom/server';

export const healthEndpoint = defineEndpoint({
	id: 'system.health',
	path: '/api/health',
	methods: ['GET'],
	access: { kind: 'public' },
	handler: ({ requestId }) =>
		Response.json(
			{
				status: 'ok',
				service: 'octane-erp',
				architectureVersion: '0.2.0',
				requestId,
			},
			{ headers: { 'cache-control': 'no-store' } },
		),
});
