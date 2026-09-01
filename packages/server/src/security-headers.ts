import type { Middleware } from '@octanejs/app-core';

export interface SecurityHeadersOptions {
	/** Only meaningful behind TLS; pairs with secure session cookies. */
	readonly strictTransportSecurity: boolean;
	readonly contentSecurityPolicy: string | null;
	/** Sends the policy as Content-Security-Policy-Report-Only. */
	readonly reportOnly: boolean;
}

const SHARED_DIRECTIVES = [
	"default-src 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
];

/* The Vite dev server injects inline module scripts, evaluates transformed
   sources, and keeps an HMR WebSocket open. */
export const DEVELOPMENT_CONTENT_SECURITY_POLICY = [
	...SHARED_DIRECTIVES,
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"img-src 'self' data: blob:",
	"connect-src 'self' ws: wss:",
].join('; ');

/* The built shell still carries an inline boot script in platform/index.html
   that octane does not nonce, so script-src cannot drop 'unsafe-inline' yet.
   Once that script carries the octane nonce, replace it with a nonce source. */
export const PRODUCTION_CONTENT_SECURITY_POLICY = [
	...SHARED_DIRECTIVES,
	"script-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
].join('; ');

export function securityHeaders(
	options: SecurityHeadersOptions,
): Readonly<Record<string, string>> {
	const headers: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'x-frame-options': 'DENY',
		'permissions-policy':
			'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	};
	if (options.strictTransportSecurity) {
		headers['strict-transport-security'] =
			'max-age=31536000; includeSubDomains';
	}
	if (options.contentSecurityPolicy) {
		headers[
			options.reportOnly
				? 'content-security-policy-report-only'
				: 'content-security-policy'
		] = options.contentSecurityPolicy;
	}
	return headers;
}

function withHeaders(
	response: Response,
	headers: readonly (readonly [string, string])[],
): Response {
	const target = (() => {
		try {
			response.headers.set('x-coreloom-probe', '1');
			response.headers.delete('x-coreloom-probe');
			return response;
		} catch {
			// Redirect and error responses carry immutable headers.
			return new Response(response.body, response);
		}
	})();
	for (const [name, value] of headers) {
		if (!target.headers.has(name)) target.headers.set(name, value);
	}
	return target;
}

/* A route that sets its own header wins; the middleware only fills gaps. */
export function createSecurityHeadersMiddleware(
	options: SecurityHeadersOptions,
): Middleware {
	const headers = Object.entries(securityHeaders(options));
	return async (_context, next) => withHeaders(await next(), headers);
}
