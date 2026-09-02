import { describe, expect, it } from 'vitest';
import {
	authPathForScreen,
	authScreenFromUrl,
	canonicalAuthLocation,
	isAuthRouteUrl,
} from '../src/client/state.ts';

describe('authentication routes', () => {
	it('maps every public authentication route to its dedicated screen', () => {
		expect(authScreenFromUrl('/auth/register')).toBe('sign-up');
		expect(authScreenFromUrl('/auth/forgot-password')).toBe('forgot-password');
		expect(authScreenFromUrl('/auth/reset-password?token=opaque')).toBe(
			'reset-password',
		);
		expect(authScreenFromUrl('/auth/accept-invitation?token=opaque')).toBe(
			'accept-invitation',
		);
		expect(authScreenFromUrl('/auth/mfa?mfa=oidc')).toBe('mfa-challenge');
		expect(authScreenFromUrl('/auth/login')).toBe('sign-in');
		expect(authScreenFromUrl('/')).toBe('sign-in');
	});

	it('keeps the former public URLs as aliases', () => {
		expect(authScreenFromUrl('/sign-in')).toBe('sign-in');
		expect(authScreenFromUrl('/sign-up')).toBe('sign-up');
		expect(authScreenFromUrl('/forgot-password')).toBe('forgot-password');
		expect(authScreenFromUrl('/reset-password?token=opaque')).toBe(
			'reset-password',
		);
		expect(authScreenFromUrl('/accept-invitation?token=opaque')).toBe(
			'accept-invitation',
		);
		expect(authScreenFromUrl('/sign-in?mfa=oidc')).toBe('mfa-challenge');
	});

	it('provides one canonical location for each public flow', () => {
		expect(authPathForScreen('sign-in')).toBe('/auth/login');
		expect(authPathForScreen('sign-up')).toBe('/auth/register');
		expect(canonicalAuthLocation('/sign-in')).toBe('/auth/login');
		expect(canonicalAuthLocation('/reset-password?token=opaque#form')).toBe(
			'/auth/reset-password?token=opaque#form',
		);
		expect(canonicalAuthLocation('/sign-in?mfa=oidc')).toBe(
			'/auth/mfa?mfa=oidc',
		);
	});

	it('distinguishes auth aliases from application and root URLs', () => {
		expect(isAuthRouteUrl('/auth/login')).toBe(true);
		expect(isAuthRouteUrl('/sign-up')).toBe(true);
		expect(isAuthRouteUrl('/app/acme/overview')).toBe(false);
		expect(isAuthRouteUrl('/')).toBe(false);
	});
});
