import { describe, expect, it } from 'vitest';
import { applicationInitialUrl, platformSurfaceFromUrl } from './routing.ts';

describe('platform surface routing', () => {
	/* The public site is a separate application. This one serves the workspace
	   at the root, so a signed-out visitor lands on sign-in. */
	it('opens the root in the application', () => {
		expect(platformSurfaceFromUrl('/')).toBe('application');
		expect(applicationInitialUrl('/')).toBe('/');
	});

	it.each([
		'/auth/login',
		'/auth/register',
		'/auth/forgot-password',
		'/auth/reset-password?token=opaque',
		'/auth/accept-invitation?token=opaque',
		'/auth/mfa?mfa=oidc',
		'/sign-in',
		'/sign-up',
	])('recognizes %s as a public authentication route', (url) => {
		expect(platformSurfaceFromUrl(url)).toBe('auth');
		expect(applicationInitialUrl(url)).toBe('/app');
	});

	it.each(['/app', '/app/acme', '/app/acme/parties', '/acme/parties'])(
		'recognizes %s as an application route',
		(url) => {
			expect(platformSurfaceFromUrl(url)).toBe('application');
			expect(applicationInitialUrl(url)).toBe(url);
		},
	);
});
