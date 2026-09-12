import { ServerRoute, type Context } from '@octanejs/app-core';
import { serverLogger } from './log.ts';
import { serverMetrics } from './metrics.ts';
import {
	formatTraceParent,
	runWithTrace,
	type TraceContext,
} from './trace/context.ts';
import { serverTracer, type Span } from './trace/tracer.ts';

export interface EndpointIdentity {
	readonly subjectId: string;
	readonly permissions: ReadonlySet<string>;
}

export interface EndpointExecutionContext {
	readonly requestId: string;
	/**
	 * The W3C trace this request runs in: the caller's `traceparent` when it
	 * sent a usable one, a new root otherwise. It is the ambient trace for
	 * everything the handler awaits and it is returned in the response header.
	 */
	readonly trace: TraceContext;
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
	traceparent: string,
): Response {
	return Response.json(
		{ error: { code, message }, requestId },
		{ status, headers: { 'cache-control': 'no-store', traceparent } },
	);
}

function requestIdOf(context: Context): string {
	const header = context.request.headers.get('x-request-id');
	return header && header.length <= 128 ? header : crypto.randomUUID();
}

export function defineEndpoint(
	definition: EndpointDefinition,
): DefinedEndpoint {
	if (
		!definition.access ||
		(definition.access.kind !== 'public' &&
			definition.access.kind !== 'permission') ||
		(definition.access.kind === 'permission' &&
			(!definition.access.permission?.trim() ||
				!('resolveIdentity' in definition) ||
				typeof definition.resolveIdentity !== 'function')) ||
		(definition.access.kind === 'public' && 'resolveIdentity' in definition)
	) {
		throw new Error(
			`Endpoint "${definition.id}" has an invalid access policy.`,
		);
	}
	if (definition.methods.length === 0) {
		throw new Error(
			`Endpoint "${definition.id}" must declare at least one HTTP method.`,
		);
	}

	const serve = async (
		context: Context,
		requestId: string,
		span: Span,
	): Promise<Response> => {
		const traceparent = formatTraceParent(span.context);
		const startedAt = performance.now();
		let identity: EndpointIdentity | null = null;
		let status = 500;
		try {
			if (
				definition.access.kind === 'permission' &&
				'resolveIdentity' in definition
			) {
				identity = await definition.resolveIdentity(context);
				if (!identity) {
					status = 401;
					return problem(
						401,
						'UNAUTHENTICATED',
						'Authentication is required.',
						requestId,
						traceparent,
					);
				}
				if (!identity.permissions.has(definition.access.permission)) {
					status = 403;
					return problem(
						403,
						'FORBIDDEN',
						'The required permission was not granted.',
						requestId,
						traceparent,
					);
				}
			}

			const response = await definition.handler({
				requestId,
				trace: span.context,
				identity,
				octane: context,
			});
			response.headers.set('x-request-id', requestId);
			response.headers.set('traceparent', traceparent);
			status = response.status;
			return response;
		} catch (error) {
			/* An unexpected error may carry SQL parameters, provider responses, or
			   credentials in its message and attached fields. The request id and
			   endpoint identify the failure without sending that value to a logger. */
			serverLogger().error('endpoint failed', {
				requestId,
				endpoint: definition.id,
				err: { name: error instanceof Error ? error.name : 'non-error' },
			});
			return problem(
				500,
				'INTERNAL_ERROR',
				'The request could not be completed.',
				requestId,
				traceparent,
			);
		} finally {
			span.setAttribute('http.response.status_code', status);
			span.end(status >= 500 ? 'error' : 'ok');
			serverMetrics().recordHttpRequest({
				endpoint: definition.id,
				method: context.request.method,
				status,
				durationSeconds: (performance.now() - startedAt) / 1000,
			});
		}
	};

	const serverRoute = new ServerRoute({
		path: definition.path,
		methods: definition.methods.map((method) => method.toUpperCase()),
		handler: (context) => {
			const requestId = requestIdOf(context);
			/* An inbound header names the parent; an absent or malformed one is a
			   new root, so a request always belongs to exactly one trace. */
			const span = serverTracer().startSpan(definition.id, {
				traceparent: context.request.headers.get('traceparent'),
				kind: 'server',
				attributes: {
					'flowdular.endpoint': definition.id,
					'flowdular.request_id': requestId,
					'http.request.method': context.request.method,
				},
			});
			return runWithTrace(span.context, () => serve(context, requestId, span));
		},
	});

	return Object.freeze({
		id: definition.id,
		access: definition.access,
		serverRoute,
	});
}
