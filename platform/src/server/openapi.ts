import {
	buildOpenApiDocument,
	defineEndpoint,
	jsonResponse,
	type EndpointIdentity,
} from '@flowdular/server';
import type { Context, ServerRoute } from '@octanejs/app-core';
import { platformVersion } from './metrics.ts';

export interface OpenApiRoutesOptions {
	/** The caller the document is built for; the platform passes auth.core's. */
	readonly resolveIdentity: (
		context: Context,
	) => EndpointIdentity | null | Promise<EndpointIdentity | null>;
	/** Absolute address callers reach this deployment at, when configured. */
	readonly publicBaseUrl?: string | null;
	readonly title?: string;
	readonly version?: string;
}

/**
 * The OpenAPI 3.1 description of this deployment, for a caller that holds a
 * credential: a browser session or an API token.
 *
 * The endpoint declares itself public and resolves the identity in the handler
 * because the document has no single permission that would gate it. It is
 * built per caller instead, from the endpoints the composition defined, and
 * carries exactly the operations that credential may reach. A caller with no
 * credential is told to authenticate, the way the metrics endpoint answers its
 * own token check.
 */
export function createOpenApiRoutes(
	options: OpenApiRoutesOptions,
): readonly ServerRoute[] {
	const endpoint = defineEndpoint({
		id: 'system.openapi',
		path: '/api/openapi.json',
		methods: ['GET'],
		access: { kind: 'public' },
		documentation: {
			summary: 'Describe every operation this credential may call',
			description:
				'OpenAPI 3.1, built for the presented credential: an operation whose permission the caller does not hold, and an operation of a module inactive in its workspace, is left out.',
			responses: [
				{ status: 200, description: 'The API description of this deployment.' },
			],
		},
		handler: async ({ octane }) => {
			const identity = await options.resolveIdentity(octane);
			if (!identity) {
				const denied = jsonResponse(
					{
						error: {
							code: 'UNAUTHENTICATED',
							message: 'Authentication is required.',
						},
					},
					401,
				);
				denied.headers.set('www-authenticate', 'Bearer');
				return denied;
			}
			const document = await buildOpenApiDocument({
				title: options.title ?? 'Flowdular API',
				version: options.version ?? platformVersion(),
				serverUrl: options.publicBaseUrl || octane.url.origin,
				permissions: identity.permissions,
				...(identity.tenantId === undefined
					? {}
					: { tenantId: identity.tenantId }),
			});
			return jsonResponse(document);
		},
	});
	return [endpoint.serverRoute];
}
