import { ServerRoute, type Context } from '@octanejs/app-core';

export interface EndpointIdentity {
	readonly subjectId: string;
	readonly permissions: ReadonlySet<string>;
}

export interface EndpointExecutionContext {
	readonly requestId: string;
	readonly identity: EndpointIdentity | null;
	readonly octane: Context;
}

type EndpointHandler = (
	context: EndpointExecutionContext,
) => Response | Promise<Response>;

interface EndpointBase {
	readonly id: string;
	readonly path: string;
	readonly methods: readonly string[];
	readonly handler: EndpointHandler;
}

interface PublicEndpoint extends EndpointBase {
	readonly access: { readonly kind: 'public' };
}

interface ProtectedEndpoint extends EndpointBase {
	readonly access: { readonly kind: 'permission'; readonly permission: string };
	readonly resolveIdentity: (
		context: Context,
	) => EndpointIdentity | null | Promise<EndpointIdentity | null>;
}

export type EndpointDefinition = PublicEndpoint | ProtectedEndpoint;

export interface DefinedEndpoint {
	readonly id: string;
	readonly access: EndpointDefinition['access'];
	readonly serverRoute: ServerRoute;
}

function problem(
	status: number,
	code: string,
	message: string,
	requestId: string,
): Response {
	return Response.json(
		{ error: { code, message }, requestId },
		{ status, headers: { 'cache-control': 'no-store' } },
	);
}

function requestIdOf(context: Context): string {
	const header = context.request.headers.get('x-request-id');
	return header && header.length <= 128 ? header : crypto.randomUUID();
}

export function defineEndpoint(
	definition: EndpointDefinition,
): DefinedEndpoint {
	if (definition.methods.length === 0) {
		throw new Error(
			`Endpoint "${definition.id}" must declare at least one HTTP method.`,
		);
	}

	const serverRoute = new ServerRoute({
		path: definition.path,
		methods: definition.methods.map((method) => method.toUpperCase()),
		handler: async (context) => {
			const requestId = requestIdOf(context);
			let identity: EndpointIdentity | null = null;

			if ('resolveIdentity' in definition) {
				identity = await definition.resolveIdentity(context);
				if (!identity)
					return problem(
						401,
						'UNAUTHENTICATED',
						'Authentication is required.',
						requestId,
					);
				if (!identity.permissions.has(definition.access.permission)) {
					return problem(
						403,
						'FORBIDDEN',
						'The required permission was not granted.',
						requestId,
					);
				}
			}

			try {
				const response = await definition.handler({
					requestId,
					identity,
					octane: context,
				});
				response.headers.set('x-request-id', requestId);
				return response;
			} catch (error) {
				console.error(`[${requestId}] endpoint ${definition.id} failed`, error);
				return problem(
					500,
					'INTERNAL_ERROR',
					'The request could not be completed.',
					requestId,
				);
			}
		},
	});

	return Object.freeze({
		id: definition.id,
		access: definition.access,
		serverRoute,
	});
}
