import type { Middleware } from '@octanejs/app-core';

/* Declared rather than echoed: a preflight answers what this deployment
   accepts, so a caller cannot widen the policy by asking for more. */
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = [
	'authorization',
	'content-type',
	'x-request-id',
	'traceparent',
	'idempotency-key',
].join(', ');
const EXPOSED_HEADERS = ['x-request-id', 'traceparent'].join(', ');
const MAX_ORIGIN_LENGTH = 256;
const DEFAULT_MAX_AGE_SECONDS = 600;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export interface CorsOptions {
	/**
	 * Whether a browser at this origin may read a cross-origin response. It is
	 * asked on the preflight, which carries no credential, so it answers for
	 * the deployment and never for one token; the credential's own rule is
	 * enforced on the request that carries it.
	 */
	readonly allowOrigin: (origin: string) => boolean | Promise<boolean>;
	/** Only addresses under this prefix take part. */
	readonly prefix?: string;
	readonly maxAgeSeconds?: number;
}

function usableOrigin(value: string | null): string | null {
	if (!value || value.length > MAX_ORIGIN_LENGTH || !ORIGIN.test(value)) {
		return null;
	}
	return value;
}

/**
 * Cross-origin access for the API, off until an origin is allowed.
 *
 * A response never carries `access-control-allow-credentials`, so a browser
 * cannot read an API response using the dashboard's own session cookie: a
 * cross-origin caller has to present an API token, which is the credential the
 * workspace issued for exactly that. Cookie-borne mutations stay closed by the
 * same-origin and CSRF checks the session guard already performs.
 */
export function createCorsMiddleware(options: CorsOptions): Middleware {
	const prefix = options.prefix ?? '/api/';
	const maxAge = String(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS);
	return async (context, next) => {
		const origin = usableOrigin(context.request.headers.get('origin'));
		const preflight =
			context.request.method === 'OPTIONS' &&
			context.request.headers.get('access-control-request-method') !== null;
		if (!origin || !context.url.pathname.startsWith(prefix)) {
			/* A preflight for an address outside the API is answered here too:
			   no route declares OPTIONS, so falling through would 404 and the
			   browser would report a CORS failure for an unrelated reason. */
			return preflight
				? new Response(null, { status: 204, headers: { vary: 'origin' } })
				: next();
		}
		if (origin === context.url.origin) return next();
		const allowed = await options.allowOrigin(origin);
		if (preflight) {
			return new Response(null, {
				status: 204,
				headers: {
					vary: 'origin, access-control-request-method, access-control-request-headers',
					'cache-control': 'no-store',
					...(allowed
						? {
								'access-control-allow-origin': origin,
								'access-control-allow-methods': ALLOWED_METHODS,
								'access-control-allow-headers': ALLOWED_HEADERS,
								'access-control-max-age': maxAge,
							}
						: {}),
				},
			});
		}
		const response = await next();
		response.headers.append('vary', 'origin');
		if (allowed) {
			response.headers.set('access-control-allow-origin', origin);
			response.headers.set('access-control-expose-headers', EXPOSED_HEADERS);
		}
		return response;
	};
}
