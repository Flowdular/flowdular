import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import {
	changeOwnPassword,
	loadOwnLanguagePreference,
	updateOwnLanguagePreference,
	updateOwnProfile,
} from '../src/client/api.ts';
import { validatePasswordChange } from '../src/client/password.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('profile client', () => {
	it('ships every dynamic password validation message', () => {
		registerModuleTranslations([
			{
				moduleId: 'profile.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		for (const [values, expected] of [
			[
				{
					currentPassword: '',
					newPassword: 'new-secret',
					confirmation: 'new-secret',
				},
				'Wpisz obecne i nowe hasło.',
			],
			[
				{
					currentPassword: 'current-secret',
					newPassword: 'new-secret',
					confirmation: 'different-secret',
				},
				'Nowe hasło i jego powtórzenie nie są identyczne.',
			],
		] as const) {
			const validation = validatePasswordChange(values);
			expect(validation.valid).toBe(false);
			if (!validation.valid) {
				expect(t('profile.password.validation.' + validation.code)).toBe(
					expected,
				);
			}
		}
		setActiveLocale('en');
	});

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
			code: 'required',
		});
		expect(
			validatePasswordChange({
				currentPassword: 'current-secret',
				newPassword: 'new-secret',
				confirmation: 'different-secret',
			}),
		).toEqual({
			valid: false,
			code: 'mismatch',
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

	it('loads and updates the server-backed language preference', async () => {
		const preference = {
			tenantId: 'tenant-a',
			accountId: 'account-a',
			locale: 'pl',
			updatedAt: 1,
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ locale: 'pl' }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ preference }), { status: 200 }),
			);
		vi.stubGlobal('fetch', fetchMock);

		await expect(loadOwnLanguagePreference()).resolves.toBe('pl');
		await expect(
			updateOwnLanguagePreference('pl', 'csrf-token'),
		).resolves.toEqual(preference);

		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/profile/language');
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			credentials: 'same-origin',
		});
		expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/profile/language');
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
			method: 'PUT',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': 'csrf-token',
			},
		});
		expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
			locale: 'pl',
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
