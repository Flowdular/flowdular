import type { Middleware } from '@octanejs/app-core';

export interface SecurityHeadersOptions {
	/** Only meaningful behind TLS; pairs with secure session cookies. */
	readonly strictTransportSecurity: boolean;
	readonly contentSecurityPolicy: string | null;
	/** Sends the policy as Content-Security-Policy-Report-Only. */
	readonly reportOnly: boolean;
	/** HTML marker replaced with the request CSP nonce, when the response is HTML. */
	readonly noncePlaceholder?: string;
}

export const CSP_NONCE_PLACEHOLDER = '__CORELOOM_CSP_NONCE__';

function cspNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let value = '';
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
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

export const PRODUCTION_CONTENT_SECURITY_POLICY = [
	...SHARED_DIRECTIVES,
	`script-src 'self' 'nonce-${CSP_NONCE_PLACEHOLDER}'`,
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
	return async (_context, next) => {
		const nonce = cspNonce();
		const placeholder = options.noncePlaceholder ?? CSP_NONCE_PLACEHOLDER;
		const policy =
			options.contentSecurityPolicy?.replaceAll(placeholder, nonce) ?? null;
		let response = await next();
		/* The placeholder only exists in the platform shell. Avoid reading API or
		   streamed responses, and preserve their body untouched. */
		if (
			policy !== null &&
			response.headers.get('content-type')?.includes('text/html') &&
			response.body !== null
		) {
			const html = await response.text();
			const transformedHeaders = new Headers(response.headers);
			/* The nonce changes the representation bytes. Any upstream length or
			   validator describes the placeholder document and must not survive. */
			transformedHeaders.delete('content-length');
			transformedHeaders.delete('etag');
			transformedHeaders.delete('content-md5');
			response = new Response(html.replaceAll(placeholder, nonce), {
				status: response.status,
				statusText: response.statusText,
				headers: transformedHeaders,
			});
		}
		const headers = Object.entries(
			securityHeaders({ ...options, contentSecurityPolicy: policy }),
		);
		return withHeaders(response, headers);
	};
}
