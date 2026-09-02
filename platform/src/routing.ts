const LEGACY_AUTH_PATHS = new Set([
	'/sign-in',
	'/sign-up',
	'/forgot-password',
	'/reset-password',
	'/accept-invitation',
]);

export type PlatformSurface = 'auth' | 'application';

export function platformSurfaceFromUrl(value: string): PlatformSurface {
	const pathname = new URL(value, 'https://coreloom.local').pathname;
	if (
		pathname === '/auth' ||
		pathname.startsWith('/auth/') ||
		LEGACY_AUTH_PATHS.has(pathname)
	) {
		return 'auth';
	}
	return 'application';
}

/* Signing in from an authentication URL must not leave that URL as the shell
   location, or the workspace would open on a view that does not exist. */
export function applicationInitialUrl(value: string): string {
	return platformSurfaceFromUrl(value) === 'auth' ? '/app' : value;
}
