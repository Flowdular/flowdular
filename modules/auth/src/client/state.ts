import { cell, createStore } from 'segment-state';
import type { AuthPrincipal } from '../domain/types.ts';

export type AuthClientStatus =
	| 'checking'
	| 'anonymous'
	| 'submitting'
	| 'authenticated';
export type AuthScreen =
	| 'sign-in'
	| 'sign-up'
	| 'forgot-password'
	| 'reset-password'
	| 'accept-invitation'
	| 'mfa-challenge';
export type SignUpStep = 1 | 2 | 3;

export interface WorkspaceSlugCheck {
	status: 'idle' | 'checking' | 'available' | 'unavailable';
	message: string;
}

const AUTH_PATHS: Readonly<Record<AuthScreen, string>> = {
	'sign-in': '/auth/login',
	'sign-up': '/auth/register',
	'forgot-password': '/auth/forgot-password',
	'reset-password': '/auth/reset-password',
	'accept-invitation': '/auth/accept-invitation',
	'mfa-challenge': '/auth/mfa',
};

const AUTH_ROUTE_PATHS = new Set([
	...Object.values(AUTH_PATHS),
	'/auth/sign-in',
	'/auth/sign-up',
	'/sign-in',
	'/sign-up',
	'/forgot-password',
	'/reset-password',
	'/accept-invitation',
]);

export function authPathForScreen(screen: AuthScreen): string {
	return AUTH_PATHS[screen];
}

export function isAuthRouteUrl(value: string): boolean {
	const url = new URL(value, 'https://flowdular.local');
	return (
		url.pathname.startsWith('/auth/') || AUTH_ROUTE_PATHS.has(url.pathname)
	);
}

export function canonicalAuthLocation(value: string): string {
	const url = new URL(value, 'https://flowdular.local');
	return authPathForScreen(authScreenFromUrl(url.href)) + url.search + url.hash;
}

export function authScreenFromUrl(value: string): AuthScreen {
	const url = new URL(value, 'https://flowdular.local');
	if (
		url.pathname === '/auth/register' ||
		url.pathname === '/auth/sign-up' ||
		url.pathname === '/sign-up'
	)
		return 'sign-up';
	if (
		url.pathname === '/auth/forgot-password' ||
		url.pathname === '/forgot-password'
	)
		return 'forgot-password';
	if (
		url.pathname === '/auth/reset-password' ||
		url.pathname === '/reset-password'
	)
		return 'reset-password';
	if (
		url.pathname === '/auth/accept-invitation' ||
		url.pathname === '/accept-invitation'
	)
		return 'accept-invitation';
	if (url.pathname === '/auth/mfa') return 'mfa-challenge';
	if (url.searchParams.get('mfa') === 'oidc') return 'mfa-challenge';
	return 'sign-in';
}

export function createAuthClientState(initialScreen: AuthScreen = 'sign-in') {
	const store = createStore({
		status: cell<AuthClientStatus>('checking'),
		screen: cell<AuthScreen>(initialScreen),
		principal: cell<AuthPrincipal | null>(null),
		csrfToken: '',
		passwordChangeRequired: false,
		passwordMinLength: 12,
		allowSignUp: false,
		emailConfirmation: false,
		signInProviders: cell<readonly string[]>([]),
		signUpStep: cell<SignUpStep>(1),
		workspaceName: '',
		workspaceSlug: '',
		workspaceSlugEdited: false,
		workspaceSlugCheck: cell<WorkspaceSlugCheck>({
			status: 'idle',
			message: '',
		}),
		confirmationEmail: '',
		mfaChallengeToken: '',
		mfaRecoveryMode: false,
		flowNotice: '',
		error: '',
	});
	return { store, state: store.state };
}

export type AuthClientState = ReturnType<typeof createAuthClientState>;
