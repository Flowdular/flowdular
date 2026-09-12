import { applicationPath } from '@flowdular/client/routing';
import { setTenantDefaultLocale, t } from '@flowdular/client/i18n';
import type { AuthPrincipal, SignInProviderOption } from '../domain/types.ts';
import type { AuthClientState } from './state.ts';

interface SessionPayload {
	readonly principal: AuthPrincipal;
	readonly csrfToken: string;
	readonly expiresAt: number;
	readonly passwordChangeRequired?: boolean;
	readonly tenantSettings?: Record<string, unknown>;
}

interface ErrorPayload {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export class AuthClientApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'AuthClientApiError';
		this.status = status;
	}
}

export interface MfaStatusPayload {
	readonly available: boolean;
	readonly enrolled: boolean;
	readonly pending: boolean;
	/** The workspace holds unenrolled members at enrolment. */
	readonly required: boolean;
}

export interface MfaEnrollmentPayload {
	readonly secret: string;
	readonly otpauthUrl: string;
	readonly recoveryCodes: readonly string[];
}

export interface WorkspaceAvailability {
	readonly valid: boolean;
	readonly available: boolean;
	readonly message?: string;
}

export async function loadAuthConfiguration(
	auth: AuthClientState,
	/** The workspace being entered; its enabled providers come back with it. */
	workspace = '',
): Promise<void> {
	try {
		const response = await fetch(
			workspace
				? `/api/auth/config?workspace=${encodeURIComponent(workspace)}`
				: '/api/auth/config',
			{
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			},
		);
		const body = (await response.json()) as {
			readonly allowSignUp?: boolean;
			readonly emailConfirmation?: boolean;
			readonly signInProviders?: readonly string[];
			readonly passwordMinLength?: number;
			readonly workspace?: {
				readonly slug?: string;
				readonly name?: string;
			} | null;
			readonly providers?: readonly SignInProviderOption[];
		};
		if (!response.ok || typeof body.allowSignUp !== 'boolean') {
			throw new Error(t('auth.error.configuration'));
		}
		const providers = Array.isArray(body.signInProviders)
			? body.signInProviders.filter(
					(provider): provider is string => typeof provider === 'string',
				)
			: [];
		const options = Array.isArray(body.providers)
			? body.providers.filter(
					(option): option is SignInProviderOption =>
						!!option &&
						typeof option.key === 'string' &&
						typeof option.label === 'string' &&
						typeof option.startPath === 'string' &&
						option.startPath.startsWith('/api/auth/oidc/'),
				)
			: [];
		auth.store.act((transaction) => {
			transaction.set(auth.state.allowSignUp, body.allowSignUp!);
			transaction.set(
				auth.state.emailConfirmation,
				body.emailConfirmation === true,
			);
			transaction.set(auth.state.signInProviders, providers);
			transaction.set(auth.state.providerOptions, options);
			transaction.set(
				auth.state.signInWorkspaceName,
				typeof body.workspace?.name === 'string' ? body.workspace.name : '',
			);
			/* A resolved workspace answers with its canonical id, and that is what
			   the sign-in request carries, so the session opens where the screen
			   says it does. An unresolved reference keeps what was typed. */
			if (typeof body.workspace?.slug === 'string') {
				transaction.set(auth.state.signInWorkspace, body.workspace.slug);
			}
			if (typeof body.passwordMinLength === 'number') {
				transaction.set(auth.state.passwordMinLength, body.passwordMinLength);
			}
			if (
				!body.allowSignUp &&
				auth.store.get(auth.state.screen) === 'sign-up'
			) {
				transaction.set(auth.state.screen, 'sign-in');
			}
		}, 'auth/configuration');
		if (!body.allowSignUp && auth.store.get(auth.state.screen) === 'sign-in') {
			history.replaceState(null, '', '/auth/login');
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
		throw new Error(body.error?.message ?? t('auth.signup.slug.error'));
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
		throw new AuthClientApiError(
			response.status,
			body.error?.message ?? t('auth.error.request'),
		);
	}
	return body;
}

/* auth.core owns the session, so it is the layer that publishes the workspace
   default locale into the shell's translation runtime. */
function commitSession(auth: AuthClientState, session: SessionPayload): void {
	const defaultLocale = session.tenantSettings?.['defaultLocale'];
	setTenantDefaultLocale(
		typeof defaultLocale === 'string' ? defaultLocale : null,
	);
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
		commitAnonymous(auth, t('auth.error.unavailable'));
	}
}

export async function signIn(
	auth: AuthClientState,
	input: {
		readonly email: string;
		readonly password: string;
		/** The workspace the screen resolved; the session opens in it. */
		readonly workspace?: string;
	},
): Promise<void> {
	auth.store.act((transaction) => {
		transaction.set(auth.state.status, 'submitting');
		transaction.set(auth.state.error, '');
		transaction.set(auth.state.flowNotice, '');
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
		const body = (await response.json()) as
			| (SessionPayload & ErrorPayload)
			| ({
					readonly mfaRequired: true;
					readonly challengeToken: string;
					readonly expiresAt: number;
			  } & ErrorPayload);
		if (!response.ok) {
			throw new AuthClientApiError(
				response.status,
				body.error?.message ?? t('auth.error.request'),
			);
		}
		if ('mfaRequired' in body && body.mfaRequired === true) {
			auth.store.act((transaction) => {
				transaction.set(auth.state.mfaChallengeToken, body.challengeToken);
				transaction.set(auth.state.mfaRecoveryMode, false);
				transaction.set(auth.state.screen, 'mfa-challenge');
				transaction.set(auth.state.status, 'anonymous');
				transaction.set(auth.state.error, '');
			}, 'auth/mfa-required');
			history.replaceState(null, '', '/auth/mfa');
			return;
		}
		if (!('principal' in body)) {
			throw new AuthClientApiError(500, t('auth.error.request'));
		}
		commitSession(auth, body);
		history.replaceState(null, '', applicationPath());
	} catch (error) {
		commitAnonymous(
			auth,
			error instanceof Error ? error.message : t('auth.error.failed'),
		);
	}
}

async function publicMutation<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	const value = (await response.json()) as T & ErrorPayload;
	if (!response.ok) {
		throw new AuthClientApiError(
			response.status,
			value.error?.message ?? t('auth.error.request'),
		);
	}
	return value;
}

async function sessionMutation<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		body: JSON.stringify(body),
	});
	const value = (await response.json()) as T & ErrorPayload;
	if (!response.ok) {
		throw new AuthClientApiError(
			response.status,
			value.error?.message ?? t('auth.error.request'),
		);
	}
	return value;
}

export async function requestPasswordReset(email: string): Promise<void> {
	await publicMutation('/api/auth/password-reset/request', { email });
}

export async function completePasswordReset(
	token: string,
	password: string,
): Promise<void> {
	await publicMutation('/api/auth/password-reset/complete', {
		token,
		password,
	});
}

export async function acceptTenantInvitation(input: {
	readonly token: string;
	readonly displayName: string;
	readonly password: string;
}): Promise<void> {
	await publicMutation('/api/auth/invitations/accept', input);
}

export async function completeMfaChallenge(
	auth: AuthClientState,
	input: { readonly code?: string; readonly recoveryCode?: string },
): Promise<void> {
	auth.store.act((transaction) => {
		transaction.set(auth.state.status, 'submitting');
		transaction.set(auth.state.error, '');
	}, 'auth/mfa-submit');
	try {
		const session = await publicMutation<SessionPayload>(
			'/api/auth/mfa/challenge',
			{
				challengeToken: auth.store.get(auth.state.mfaChallengeToken),
				...input,
			},
		);
		commitSession(auth, session);
		auth.store.act((transaction) => {
			transaction.set(auth.state.mfaChallengeToken, '');
			transaction.set(auth.state.mfaRecoveryMode, false);
		}, 'auth/mfa-complete');
		history.replaceState(null, '', applicationPath());
	} catch (error) {
		auth.store.act((transaction) => {
			transaction.set(auth.state.status, 'anonymous');
			transaction.set(
				auth.state.error,
				error instanceof Error ? error.message : t('auth.error.failed'),
			);
		}, 'auth/mfa-failed');
	}
}

export async function loadMfaStatus(): Promise<MfaStatusPayload> {
	const response = await fetch('/api/auth/mfa/status', {
		credentials: 'same-origin',
		headers: { accept: 'application/json' },
	});
	const value = (await response.json()) as MfaStatusPayload & ErrorPayload;
	if (!response.ok) {
		throw new AuthClientApiError(
			response.status,
			value.error?.message ?? t('auth.error.request'),
		);
	}
	return value;
}

export async function enrollMfa(
	csrfToken: string,
): Promise<MfaEnrollmentPayload> {
	return sessionMutation(
		'/api/auth/mfa/enroll',
		{ issuer: 'Flowdular' },
		csrfToken,
	);
}

export async function confirmMfa(
	code: string,
	csrfToken: string,
): Promise<void> {
	await sessionMutation('/api/auth/mfa/confirm', { code }, csrfToken);
}

/* The CSRF token of the live session, for an administration surface that holds
   no session state of its own. */
export async function loadSessionCsrfToken(): Promise<string> {
	const response = await fetch('/api/auth/session', {
		credentials: 'same-origin',
		headers: { accept: 'application/json' },
	});
	const value = (await response.json()) as Partial<SessionPayload> &
		ErrorPayload;
	if (!response.ok || typeof value.csrfToken !== 'string') {
		throw new AuthClientApiError(
			response.status,
			value.error?.message ?? t('auth.error.request'),
		);
	}
	return value.csrfToken;
}

/** Clears another member's second factor; needs users.members.manage. */
export async function resetMemberMfa(
	accountId: string,
	csrfToken: string,
): Promise<void> {
	await sessionMutation('/api/auth/mfa/reset', { accountId }, csrfToken);
}

export async function createTenantInvitation(
	input: { readonly email: string; readonly role: string },
	csrfToken: string,
): Promise<{ readonly id: string; readonly expiresAt: number }> {
	return (
		await sessionMutation<{
			readonly invitation: { readonly id: string; readonly expiresAt: number };
		}>('/api/auth/invitations', input, csrfToken)
	).invitation;
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
		history.replaceState(null, '', applicationPath());
	} catch (error) {
		commitAnonymous(
			auth,
			error instanceof Error ? error.message : t('auth.error.failed'),
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
			throw new Error(body.error?.message ?? t('auth.error.signOut'));
		}
		commitAnonymous(auth);
		history.replaceState(null, '', '/auth/login');
	} catch (error) {
		auth.store.act((transaction) => {
			transaction.set(
				auth.state.error,
				error instanceof Error ? error.message : t('auth.error.signOut'),
			);
		}, 'auth/sign-out-failed');
	}
}
