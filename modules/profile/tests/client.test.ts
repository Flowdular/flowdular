import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeOwnPassword, updateOwnProfile } from '../src/client/api.ts';
import { validatePasswordChange } from '../src/client/password.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('profile client', () => {
	it('maps matching password fields without sending confirmation', () => {
		expect(
			validatePasswordChange({
				currentPassword: 'current-secret',
				newPassword: 'new-secret',
				confirmation: 'new-secret',
			}),
		).toEqual({
			valid: true,
			input: {
				currentPassword: 'current-secret',
				newPassword: 'new-secret',
			},
		});
	});

	it('rejects missing and mismatched password fields before a request', () => {
		expect(
			validatePasswordChange({
				currentPassword: '',
				newPassword: 'new-secret',
				confirmation: 'new-secret',
			}),
		).toEqual({
			valid: false,
			message: 'Enter your current password and a new password.',
		});
		expect(
			validatePasswordChange({
				currentPassword: 'current-secret',
				newPassword: 'new-secret',
				confirmation: 'different-secret',
			}),
		).toEqual({
			valid: false,
			message: 'The new password and confirmation do not match.',
		});
	});

	it('posts password changes to auth.core with CSRF protection', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ changed: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await changeOwnPassword(
			{
				currentPassword: 'current-secret',
				newPassword: 'new-secret',
			},
			'csrf-token',
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/auth/password');
		expect(options.method).toBe('POST');
		expect(options.credentials).toBe('same-origin');
		expect(options.headers).toEqual({
			'content-type': 'application/json',
			'x-csrf-token': 'csrf-token',
		});
		expect(JSON.parse(options.body as string)).toEqual({
			currentPassword: 'current-secret',
			newPassword: 'new-secret',
		});
	});

	it('updates only the signed-in profile with CSRF protection', async () => {
		const profile = {
			tenantId: 'tenant-a',
			accountId: 'account-a',
			displayName: 'Ada Lovelace',
			updatedAt: 1,
		};
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ profile }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			updateOwnProfile({ displayName: 'Ada Lovelace' }, 'csrf-token'),
		).resolves.toEqual(profile);

		const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/profile');
		expect(options.method).toBe('PUT');
		expect(options.credentials).toBe('same-origin');
		expect(options.headers).toEqual({
			'content-type': 'application/json',
			'x-csrf-token': 'csrf-token',
		});
		expect(JSON.parse(options.body as string)).toEqual({
			displayName: 'Ada Lovelace',
		});
	});

	it('throws the auth server error message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						error: {
							message: 'The current password is incorrect.',
						},
					}),
					{
						status: 400,
						headers: { 'content-type': 'application/json' },
					},
				),
			),
		);

		await expect(
			changeOwnPassword(
				{
					currentPassword: 'incorrect-secret',
					newPassword: 'new-secret',
				},
				'csrf-token',
			),
		).rejects.toThrow('The current password is incorrect.');
	});
});
