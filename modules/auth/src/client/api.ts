import type { AuthPrincipal } from '../domain/types.ts';
import type { AuthClientState } from './state.ts';

interface SessionPayload {
	readonly principal: AuthPrincipal;
	readonly csrfToken: string;
	readonly expiresAt: number;
	readonly passwordChangeRequired?: boolean;
}

interface ErrorPayload {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export interface WorkspaceAvailability {
	readonly valid: boolean;
	readonly available: boolean;
	readonly message?: string;
}

export async function loadAuthConfiguration(
	auth: AuthClientState,
): Promise<void> {
	try {
		const response = await fetch('/api/auth/config', {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
		});
		const body = (await response.json()) as {
			readonly allowSignUp?: boolean;
			readonly emailConfirmation?: boolean;
			readonly signInProviders?: readonly string[];
			readonly passwordMinLength?: number;
		};
		if (!response.ok || typeof body.allowSignUp !== 'boolean') {
			throw new Error('Authentication configuration is unavailable.');
		}
		const providers = Array.isArray(body.signInProviders)
			? body.signInProviders.filter(
					(provider): provider is string => typeof provider === 'string',
				)
			: [];
		auth.store.act((transaction) => {
			transaction.set(auth.state.allowSignUp, body.allowSignUp!);
			transaction.set(
				auth.state.emailConfirmation,
				body.emailConfirmation === true,
			);
			transaction.set(auth.state.signInProviders, providers);
			if (typeof body.passwordMinLength === 'number') {
				transaction.set(auth.state.passwordMinLength, body.passwordMinLength);
			}
			if (!body.allowSignUp) transaction.set(auth.state.screen, 'sign-in');
		}, 'auth/configuration');
		if (!body.allowSignUp && window.location.pathname === '/sign-up') {
			history.replaceState(null, '', '/sign-in');
		}
	} catch {
		auth.store.act(
			(transaction) => transaction.set(auth.state.allowSignUp, false),
			'auth/configuration-denied',
		);
	}
}

export async function checkWorkspaceAvailability(
	slug: string,
): Promise<WorkspaceAvailability> {
	const response = await fetch(
		'/api/auth/workspace-availability?slug=' + encodeURIComponent(slug),
		{
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
		},
	);
	const body = (await response.json()) as {
		readonly valid?: boolean;
		readonly available?: boolean;
		readonly message?: string;
	} & ErrorPayload;
	if (!response.ok) {
		throw new Error(body.error?.message ?? 'Availability check failed.');
	}
	return {
		valid: body.valid === true,
		available: body.available === true,
		...(typeof body.message === 'string' ? { message: body.message } : {}),
	};
}

async function payload(response: Response): Promise<SessionPayload> {
	const body = (await response.json()) as SessionPayload & ErrorPayload;
	if (!response.ok) {
		throw new Error(body.error?.message ?? 'Authentication request failed.');
	}
	return body;
}

function commitSession(auth: AuthClientState, session: SessionPayload): void {
	auth.store.act((transaction) => {
		transaction.set(auth.state.principal, session.principal);
		transaction.set(auth.state.csrfToken, session.csrfToken);
		transaction.set(
			auth.state.passwordChangeRequired,
			session.passwordChangeRequired === true,
		);
		transaction.set(auth.state.error, '');
		transaction.set(auth.state.status, 'authenticated');
	}, 'auth/session');
}

function commitAnonymous(auth: AuthClientState, error = ''): void {
	auth.store.act((transaction) => {
		transaction.set(auth.state.principal, null);
		transaction.set(auth.state.csrfToken, '');
		transaction.set(auth.state.error, error);
		transaction.set(auth.state.status, 'anonymous');
	}, 'auth/anonymous');
}

export async function loadSession(auth: AuthClientState): Promise<void> {
	try {
		const response = await fetch('/api/auth/session', {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
		});
		if (response.status === 401) {
			commitAnonymous(auth);
			return;
		}
		commitSession(auth, await payload(response));
	} catch {
		commitAnonymous(auth, 'Authentication service is unavailable.');
	}
}

export async function signIn(
	auth: AuthClientState,
	input: { readonly email: string; readonly password: string },
): Promise<void> {
	auth.store.act((transaction) => {
		transaction.set(auth.state.status, 'submitting');
		transaction.set(auth.state.error, '');
	}, 'auth/submit');
	try {
		const response = await fetch('/api/auth/sign-in', {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify(input),
		});
		commitSession(auth, await payload(response));
		history.replaceState(null, '', '/');
	} catch (error) {
		commitAnonymous(
			auth,
			error instanceof Error ? error.message : 'Authentication failed.',
		);
	}
}

export async function signUp(
	auth: AuthClientState,
	input: {
		readonly email: string;
		readonly password: string;
		readonly displayName: string;
		readonly organizationName: string;
		readonly organizationSlug: string;
	},
): Promise<void> {
	auth.store.act((transaction) => {
		transaction.set(auth.state.status, 'submitting');
		transaction.set(auth.state.error, '');
	}, 'auth/submit');
	try {
		const response = await fetch('/api/auth/sign-up', {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
			},
			body: JSON.stringify(input),
		});
		if (response.status === 202) {
			const body = (await response.json()) as { readonly email?: string };
			auth.store.act((transaction) => {
				transaction.set(auth.state.principal, null);
				transaction.set(auth.state.csrfToken, '');
				transaction.set(auth.state.error, '');
				transaction.set(auth.state.status, 'anonymous');
				transaction.set(auth.state.signUpStep, 3);
				transaction.set(
					auth.state.confirmationEmail,
					body.email ?? input.email,
				);
			}, 'auth/confirmation-pending');
			return;
		}
		commitSession(auth, await payload(response));
		history.replaceState(null, '', '/');
	} catch (error) {
		commitAnonymous(
			auth,
			error instanceof Error ? error.message : 'Authentication failed.',
		);
	}
}

export async function switchTenant(
	auth: AuthClientState,
	tenantId: string,
): Promise<void> {
	const csrfToken = auth.store.get(auth.state.csrfToken);
	const response = await fetch('/api/auth/switch-tenant', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		body: JSON.stringify({ tenantId }),
	});
	commitSession(auth, await payload(response));
}

export async function signOut(auth: AuthClientState): Promise<void> {
	const csrfToken = auth.store.get(auth.state.csrfToken);
	try {
		const response = await fetch('/api/auth/sign-out', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { accept: 'application/json', 'x-csrf-token': csrfToken },
		});
		if (!response.ok && response.status !== 401) {
			const body = (await response.json()) as ErrorPayload;
			throw new Error(body.error?.message ?? 'Sign out failed.');
		}
		commitAnonymous(auth);
		history.replaceState(null, '', '/sign-in');
	} catch (error) {
		auth.store.act((transaction) => {
			transaction.set(
				auth.state.error,
				error instanceof Error ? error.message : 'Sign out failed.',
			);
		}, 'auth/sign-out-failed');
	}
}
