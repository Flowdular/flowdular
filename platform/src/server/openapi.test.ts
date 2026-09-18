import { createContext } from '@octanejs/app-core';
import { createOpenApiRoutes, serverEndpointCatalog } from '@flowdular/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHealthEndpoint } from './health.ts';

beforeEach(() => {
	serverEndpointCatalog().beginGeneration();
});

describe('platform endpoints in the API document', () => {
	/* The catalogue is cleared when a generation starts composing, so a platform
	   endpoint built at import time would be recorded before that and never
	   appear. Health is the one that used to be. */
	it('describes a platform endpoint the generation builds', async () => {
		createHealthEndpoint();
		const routes = createOpenApiRoutes({
			resolveIdentity: () => ({
				subjectId: 'session-1',
				tenantId: 'tenant-1',
				permissions: new Set<string>(),
			}),
		});
		const response = await routes[0]!.handler(
			createContext(new Request('https://erp.example/api/openapi.json'), {}),
		);
		const document = (await response.json()) as {
			paths: Record<string, Record<string, { operationId: string }>>;
		};
		expect(document.paths['/api/health']?.get?.operationId).toBe(
			'system.health',
		);
	});
});
