import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import {
	createSecurityHeadersMiddleware,
	PRODUCTION_CONTENT_SECURITY_POLICY,
	securityHeaders,
} from '../src/security-headers.ts';

const context = () =>
	createContext(new Request('https://erp.example/api/health'), {});

describe('security headers middleware', () => {
	it('adds the baseline headers and an enforced policy', async () => {
		const middleware = createSecurityHeadersMiddleware({
			strictTransportSecurity: true,
			contentSecurityPolicy: PRODUCTION_CONTENT_SECURITY_POLICY,
			reportOnly: false,
		});
		const response = await middleware(context(), async () =>
			Response.json({ ok: true }),
		);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('referrer-policy')).toBe(
			'strict-origin-when-cross-origin',
		);
		expect(response.headers.get('permissions-policy')).toContain('camera=()');
		expect(response.headers.get('strict-transport-security')).toContain(
			'max-age=',
		);
		expect(response.headers.get('content-security-policy')).toContain(
			"frame-ancestors 'none'",
		);
		expect(response.headers.has('content-security-policy-report-only')).toBe(
			false,
		);
		expect(await response.json()).toEqual({ ok: true });
	});

	it('replaces the shell nonce marker and does not allow inline scripts in production', async () => {
		const middleware = createSecurityHeadersMiddleware({
			strictTransportSecurity: true,
			contentSecurityPolicy: PRODUCTION_CONTENT_SECURITY_POLICY,
			reportOnly: false,
		});
		const response = await middleware(context(), async () => {
			const html = '<script nonce="__CORELOOM_CSP_NONCE__">boot()</script>';
			return new Response(html, {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-length': String(new TextEncoder().encode(html).byteLength),
				},
			});
		});
		const policy = response.headers.get('content-security-policy')!;
		const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
		expect(nonce).toBeTruthy();
		expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
		expect(response.headers.has('content-length')).toBe(false);
		expect(await response.text()).toContain(`nonce="${nonce}"`);
	});

	it('reports instead of enforcing when asked and skips HSTS over plain HTTP', () => {
		const headers = securityHeaders({
			strictTransportSecurity: false,
			contentSecurityPolicy: "default-src 'self'",
			reportOnly: true,
		});
		expect(headers['content-security-policy-report-only']).toBe(
			"default-src 'self'",
		);
		expect(headers['content-security-policy']).toBeUndefined();
		expect(headers['strict-transport-security']).toBeUndefined();
	});

	it('keeps a header the route already set and survives immutable responses', async () => {
		const middleware = createSecurityHeadersMiddleware({
			strictTransportSecurity: false,
			contentSecurityPolicy: null,
			reportOnly: false,
		});
		const custom = await middleware(context(), async () =>
			Response.json({}, { headers: { 'x-frame-options': 'SAMEORIGIN' } }),
		);
		expect(custom.headers.get('x-frame-options')).toBe('SAMEORIGIN');
		const redirect = await middleware(context(), async () =>
			Response.redirect('https://erp.example/sign-in', 302),
		);
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get('location')).toBe(
			'https://erp.example/sign-in',
		);
		expect(redirect.headers.get('x-content-type-options')).toBe('nosniff');
	});
});
