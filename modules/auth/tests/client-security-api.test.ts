import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createTenantInvitation,
	loadAuthConfiguration,
	requestPasswordReset,
	signIn,
} from '../src/client/api.ts';
import { createAuthClientState } from '../src/client/state.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('auth security client API', () => {
	it('keeps reset requests non-enumerating and same-origin', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ accepted: true }, { status: 202 }),
		);
		vi.stubGlobal('fetch', fetchMock);
		await requestPasswordReset('person@example.com');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/auth/password-reset/request',
			expect.objectContaining({
				method: 'POST',
				credentials: 'same-origin',
				body: JSON.stringify({ email: 'person@example.com' }),
			}),
		);
	});

	it('sends invitation mutations with CSRF and exposes no raw token', async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ invitation: { id: 'invite-1', expiresAt: 42 } }),
		);
		vi.stubGlobal('fetch', fetchMock);
		await expect(
			createTenantInvitation(
				{ email: 'person@example.com', role: 'member' },
				'csrf-value',
			),
		).resolves.toEqual({ id: 'invite-1', expiresAt: 42 });
		const options = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(new Headers(options.headers).get('x-csrf-token')).toBe('csrf-value');
		expect(String(options.body)).not.toContain('token');
	});

	it('moves a successful password step into the MFA challenge without creating a session', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({
					mfaRequired: true,
					challengeToken: 'challenge-proof',
					expiresAt: 42,
				}),
			),
		);
		const auth = createAuthClientState();
		await signIn(auth, {
			email: 'person@example.com',
			password: 'correct horse battery staple',
		});
		expect(auth.store.get(auth.state.screen)).toBe('mfa-challenge');
		expect(auth.store.get(auth.state.mfaChallengeToken)).toBe(
			'challenge-proof',
		);
		expect(auth.store.get(auth.state.principal)).toBeNull();
	});

	it('does not replace recovery routes when public sign-up is disabled', async () => {
		const replaceState = vi.fn();
		vi.stubGlobal('window', { location: { pathname: '/reset-password' } });
		vi.stubGlobal('history', { replaceState });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({
					allowSignUp: false,
					emailConfirmation: false,
					signInProviders: [],
					passwordMinLength: 12,
				}),
			),
		);
		const auth = createAuthClientState('reset-password');
		await loadAuthConfiguration(auth);
		expect(auth.store.get(auth.state.screen)).toBe('reset-password');
		expect(replaceState).not.toHaveBeenCalled();
	});
});
