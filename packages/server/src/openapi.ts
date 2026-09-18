import type { Context, ServerRoute } from '@octanejs/app-core';
import { defineEndpoint, type EndpointIdentity } from './endpoint.ts';
import {
	serverEndpointCatalog,
	type CatalogedEndpoint,
	type EndpointParameterDocumentation,
} from './endpoint-catalog.ts';
import { jsonResponse } from './http.ts';
import { moduleOfRoute, routeActiveForTenant } from './module-activation.ts';

export interface OpenApiDocumentOptions {
	/** Defaults to every endpoint this process defined. */
	readonly endpoints?: readonly CatalogedEndpoint[];
	readonly title?: string;
	readonly version?: string;
	readonly description?: string;
	/** Absolute base address of this deployment, as the caller reached it. */
	readonly serverUrl?: string;
	/**
	 * The permissions of the caller the document is built for. An operation the
	 * caller may not call is left out, so a token reads exactly what it can do.
	 * Null documents every operation and is for an operator view, never for a
	 * response to a credential.
	 */
	readonly permissions?: ReadonlySet<string> | null;
	/** The caller's workspace; operations of modules inactive there are dropped. */
	readonly tenantId?: string;
}

export interface OpenApiDocument {
	readonly openapi: string;
	readonly info: Readonly<Record<string, unknown>>;
	readonly paths: Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const ERROR_SCHEMA = Object.freeze({
	type: 'object',
	required: ['error'],
	properties: {
		error: {
			type: 'object',
			required: ['code', 'message'],
			properties: {
				code: { type: 'string', description: 'Stable machine-readable code.' },
				message: { type: 'string' },
			},
		},
		requestId: { type: 'string' },
	},
});

const TOKEN_DESCRIPTION = [
	'A workspace API token, sent as "Authorization: Bearer <token>".',
	'Issue one in Administration, API tokens. A token acts for the workspace it',
	'was issued in and holds at most the permissions of the account that issued',
	'it; revoking either narrows it at the next request.',
].join(' ');

/** Converts a router pattern (`/a/:id`, `/a/*rest`) to OpenAPI templating. */
function templatePath(path: string): string {
	return path
		.split('/')
		.map((part) =>
			part.startsWith(':')
				? `{${part.slice(1)}}`
				: part.startsWith('*')
					? `{${part.slice(1)}}`
					: part,
		)
		.join('/');
}

function pathParameterNames(path: string): readonly string[] {
	return path
		.split('/')
		.filter((part) => part.startsWith(':') || part.startsWith('*'))
		.map((part) => part.slice(1));
}

function parameterObject(
	parameter: EndpointParameterDocumentation,
): Record<string, unknown> {
	return {
		name: parameter.name,
		in: parameter.in,
		required: parameter.in === 'path' ? true : parameter.required === true,
		...(parameter.description === undefined
			? {}
			: { description: parameter.description }),
		schema: parameter.schema ?? { type: 'string' },
	};
}

function operationParameters(
	endpoint: CatalogedEndpoint,
): readonly Record<string, unknown>[] {
	const declared = endpoint.documentation?.parameters ?? [];
	const parameters = declared.map(parameterObject);
	/* OpenAPI requires every templated segment to be declared. A module that
	   documented none still gets a valid document. */
	for (const name of pathParameterNames(endpoint.path)) {
		if (!parameters.some((parameter) => parameter.name === name)) {
			parameters.push({
				name,
				in: 'path',
				required: true,
				schema: { type: 'string' },
			});
		}
	}
	return parameters;
}

function operationResponses(
	endpoint: CatalogedEndpoint,
): Record<string, unknown> {
	const responses: Record<string, unknown> = {};
	for (const response of endpoint.documentation?.responses ?? []) {
		responses[String(response.status)] = {
			description: response.description,
			...(response.schema === undefined
				? {}
				: { content: { 'application/json': { schema: response.schema } } }),
		};
	}
	if (Object.keys(responses).length === 0) {
		responses['200'] = { description: 'The request succeeded.' };
	}
	const error = {
		content: {
			'application/json': { schema: { $ref: '#/components/schemas/Error' } },
		},
	};
	if (endpoint.access.kind === 'permission') {
		responses['401'] ??= {
			description: 'Authentication is required.',
			...error,
		};
		responses['403'] ??= {
			description:
				'The required permission was not granted, the workspace has the module inactive, or an API token attempted a mutation it may not perform.',
			...error,
		};
		/* Every credential this operation admits is rate limited, so a client
		   that reads the document knows to expect the refusal. */
		responses['429'] ??= {
			description:
				'The API token spent the requests it may make this minute; retry-after says when it resets.',
			...error,
		};
	}
	responses['500'] ??= {
		description: 'The request could not be completed.',
		...error,
	};
	return responses;
}

function operation(
	endpoint: CatalogedEndpoint,
	method: string,
	multiMethod: boolean,
): Record<string, unknown> {
	const moduleId = moduleOfRoute(endpoint.route);
	const documentation = endpoint.documentation;
	const permission =
		endpoint.access.kind === 'permission' ? endpoint.access.permission : null;
	const parameters = operationParameters(endpoint);
	return {
		operationId: multiMethod
			? `${endpoint.id}.${method.toLowerCase()}`
			: endpoint.id,
		summary: documentation?.summary ?? endpoint.id,
		description:
			documentation?.description ??
			(permission
				? `Requires the ${permission} permission.`
				: 'Open to an unauthenticated caller.'),
		tags: [moduleId ?? endpoint.id.split('.')[0]!],
		...(documentation?.deprecated === true ? { deprecated: true } : {}),
		...(parameters.length === 0 ? {} : { parameters }),
		...(BODY_METHODS.has(method) && documentation?.body
			? {
					requestBody: {
						required: true,
						...(documentation.body.description === undefined
							? {}
							: { description: documentation.body.description }),
						content: {
							'application/json': {
								schema: documentation.body.schema ?? { type: 'object' },
							},
						},
					},
				}
			: {}),
		responses: operationResponses(endpoint),
		security: permission ? [{ apiToken: [] }] : [],
		'x-flowdular-endpoint': endpoint.id,
		...(moduleId === null ? {} : { 'x-flowdular-module': moduleId }),
		...(permission === null ? {} : { 'x-flowdular-permission': permission }),
		/* A mutation needs either a browser session with its CSRF proof or an
		   API token issued with writes allowed; a read needs neither. */
		...(method === 'GET' || method === 'HEAD'
			? {}
			: { 'x-flowdular-token-write': true }),
		...(documentation ? {} : { 'x-flowdular-documented': false }),
	};
}

function visible(
	endpoint: CatalogedEndpoint,
	permissions: ReadonlySet<string> | null | undefined,
): boolean {
	if (endpoint.access.kind === 'public') return true;
	if (permissions === null || permissions === undefined) return true;
	return permissions.has(endpoint.access.permission);
}

/**
 * The OpenAPI 3.1 description of what this deployment serves, built from the
 * endpoints the running composition defined. A module appears because it
 * composed, never because it was listed somewhere, so a module a sandbox
 * session wrote is described as soon as it is enabled.
 *
 * The document is built per caller: an operation the caller has no permission
 * for, and an operation of a module inactive in the caller's workspace, is
 * left out.
 */
export async function buildOpenApiDocument(
	options: OpenApiDocumentOptions = {},
): Promise<OpenApiDocument> {
	const endpoints = options.endpoints ?? serverEndpointCatalog().list();
	const paths: Record<string, Record<string, unknown>> = {};
	const tags = new Set<string>();
	for (const endpoint of endpoints) {
		if (!visible(endpoint, options.permissions)) continue;
		if (
			options.tenantId !== undefined &&
			!(await routeActiveForTenant(endpoint.route, options.tenantId))
		) {
			continue;
		}
		const path = templatePath(endpoint.path);
		const methods = endpoint.methods.filter((method) => method !== 'HEAD');
		for (const method of methods.length ? methods : endpoint.methods) {
			const built = operation(endpoint, method, methods.length > 1);
			tags.add((built.tags as readonly string[])[0]!);
			paths[path] ??= {};
			paths[path]![method.toLowerCase()] = built;
		}
	}
	return {
		openapi: '3.1.0',
		info: {
			title: options.title ?? 'Flowdular API',
			version: options.version ?? '0.0.0',
			description:
				options.description ??
				'Every operation this deployment serves that the calling credential may reach.',
		},
		...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
		tags: [...tags].sort().map((name) => ({ name })),
		security: [{ apiToken: [] }],
		components: {
			securitySchemes: {
				apiToken: {
					type: 'http',
					scheme: 'bearer',
					description: TOKEN_DESCRIPTION,
				},
			},
			schemas: { Error: ERROR_SCHEMA },
		},
		paths: Object.fromEntries(
			Object.entries(paths).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
	};
}

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
				...(options.title === undefined ? {} : { title: options.title }),
				...(options.version === undefined ? {} : { version: options.version }),
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
