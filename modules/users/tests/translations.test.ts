import { describe, expect, it } from 'vitest';
import { translationKeys } from '@flowdular/contracts';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import { BUILTIN_ROLES } from '@flowdular/module-auth';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { roleDescription, roleName } from '../src/client/role-label.ts';

describe('users translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(translationKeys(translationsPl)).toEqual(
			translationKeys(translationsEn),
		);
	});

	it('names built-in roles in the reader locale and keeps custom role names', () => {
		registerModuleTranslations([
			{
				moduleId: 'users.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		for (const role of BUILTIN_ROLES) {
			const stored = {
				...role,
				scopes: [...role.scopes],
				id: role.key,
				tenantId: 'tenant',
				builtin: true,
				createdAt: 0,
				updatedAt: 0,
			};
			expect(roleName(stored), role.key).not.toBe(role.name);
			expect(roleDescription(stored), role.key).not.toBe(role.description);
		}
		expect(roleName({ builtin: true, key: 'owner', name: 'Owner' })).toBe(
			'Właściciel',
		);
		expect(
			roleName({ builtin: false, key: 'owner-deputy', name: 'Zastępca' }),
		).toBe('Zastępca');
		expect(t('users.pagination.summary', { page: 2, from: 26 })).toBe(
			'Strona 2 · członkowie od 26',
		);
		setActiveLocale('en');
		expect(roleName({ builtin: true, key: 'member', name: 'Member' })).toBe(
			'Member',
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
