import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

describe('users translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('resolves every member status in the active locale', () => {
		registerModuleTranslations([
			{
				moduleId: 'users.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		expect(t('users.status.active')).toBe('Aktywne');
		expect(t('users.status.disabled')).toBe('Wyłączone');
		expect(t('users.status.passwordResetPending')).toBe(
			'Oczekuje na zmianę hasła',
		);
		setActiveLocale('en');
	});

	/* USERS-EXPORT: the screen that hands the file over belongs to exports.core,
	   so the Members screen names it the way the shell does in both locales. */
	it('names the export action and the screen it points at, in both locales', () => {
		registerModuleTranslations([
			{
				moduleId: 'users.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		expect(t('users.export.action')).toBe('Export CSV');
		expect(t('users.export.link')).toContain('Exports');
		setActiveLocale('pl');
		expect(t('users.export.action')).toBe('Eksportuj CSV');
		expect(t('users.export.link')).toContain('Eksporty');
		setActiveLocale('en');
	});

	/* USERS-EDIT: the account block belongs to the deployment operator, so the
	   drawer says so instead of offering a control that would be refused. */
	it('says the account block is an operator action, in both locales', () => {
		registerModuleTranslations([
			{
				moduleId: 'users.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		expect(t('users.member.accountReadOnly')).toContain(
			'deployment operator action',
		);
		setActiveLocale('pl');
		expect(t('users.member.accountReadOnly')).toContain(
			'działanie operatora wdrożenia',
		);
		setActiveLocale('en');
	});
});
