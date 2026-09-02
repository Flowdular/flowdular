import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { registerPublicAuthTranslations } from '../src/client/translations.ts';
import { AUTH_MODULE_SETTINGS } from '../src/settings.ts';

const COMMON_KEYS = [
	'accessDenied',
	'administration',
	'cancel',
	'actions',
	'done',
	'never',
	'none',
	'refresh',
	'save',
	'saved',
	'back',
	'continue',
	'login',
	'wait',
] as const;

describe('auth translations', () => {
	it('installs the auth bundle before the anonymous shell renders', () => {
		registerModuleTranslations([]);
		setActiveLocale('en');
		expect(t('auth.common.login')).toBe('auth.common.login');
		registerPublicAuthTranslations();
		expect(t('auth.common.login')).toBe('Sign in');
	});

	it('reinstalls the public bundle after the shared catalog is rebuilt', () => {
		registerPublicAuthTranslations();
		expect(t('auth.common.login')).toBe('Sign in');

		/* Vite can replace the shared runtime without re-evaluating this module.
		   A one-shot local flag must not leave the public screen with raw keys. */
		registerModuleTranslations([]);
		expect(t('auth.common.login')).toBe('auth.common.login');

		registerPublicAuthTranslations();
		expect(t('auth.common.login')).toBe('Sign in');
	});

	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(AUTH_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^auth\./);
			expect(definition.descriptionKey).toMatch(/^auth\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('auth.'.length);
				expect(localKey in translationsEn).toBe(true);
				expect(localKey in translationsPl).toBe(true);
			}
		}
	});

	it('resolves the complete common action family in every locale', () => {
		registerModuleTranslations([
			{
				moduleId: 'auth.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const action of COMMON_KEYS) {
				const key = 'auth.common.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('resolves every dynamic token status and audit source', () => {
		registerModuleTranslations([
			{
				moduleId: 'auth.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		for (const status of ['active', 'expired', 'revoked']) {
			expect(t('auth.tokens.status.' + status)).not.toMatch(/^auth\./);
		}
		expect(t('auth.tokens.scope.one')).toBe('1 zakres');
		expect(t('auth.tokens.scope.other', { count: 2 })).toBe('Zakresy: 2');
		for (const source of ['platform', 'agents', 'sandbox']) {
			expect(t('auth.audit.source.' + source)).not.toMatch(/^auth\./);
		}
		setActiveLocale('en');
	});
});
