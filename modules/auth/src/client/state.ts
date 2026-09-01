import { cell, createStore } from 'segment-state';
import type { AuthPrincipal } from '../domain/types.ts';

export type AuthClientStatus =
	| 'checking'
	| 'anonymous'
	| 'submitting'
	| 'authenticated';
export type AuthScreen = 'sign-in' | 'sign-up';
export type SignUpStep = 1 | 2 | 3;

export interface WorkspaceSlugCheck {
	status: 'idle' | 'checking' | 'available' | 'unavailable';
	message: string;
}

export function authScreenFromUrl(value: string): AuthScreen {
	return new URL(value, 'https://octane-erp.local').pathname === '/sign-up'
		? 'sign-up'
		: 'sign-in';
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
		error: '',
	});
	return { store, state: store.state };
}

export type AuthClientState = ReturnType<typeof createAuthClientState>;
