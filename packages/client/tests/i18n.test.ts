import { describe, expect, it } from 'vitest';
import { pluralFamilyIssues, translationKeys } from '@flowdular/contracts';
import { FALLBACK_LOCALE, resolveLocale } from '../src/i18n/locale.ts';
import {
	createTranslationCatalog,
	translateFrom,
	type TranslationSource,
} from '../src/i18n/translations.ts';
import shellEn from '../src/i18n/locales/en.json';
import shellPl from '../src/i18n/locales/pl.json';
import {
	registerModuleTranslations,
	setActiveLocale,
	SUPPORTED_LOCALES,
	t,
} from '../src/i18n/runtime.ts';
import {
	NAVIGATION_GROUPS,
	navigationGroupLabel,
} from '../src/shell/navigation.ts';

const SOURCES: readonly TranslationSource[] = [
	{
		namespace: 'shell',
		bundles: {
			en: { 'account.signOut': 'Sign out' },
			pl: { 'account.signOut': 'Wyloguj się' },
		},
	},
	{
		namespace: 'catalog',
		bundles: {
			en: {
				'list.title': 'Catalog',
				'list.count': '{count} items',
				'list.hint': 'Create the first product.',
			},
			pl: { 'list.title': 'Katalog', 'list.count': 'pozycje: {count}' },
		},
	},
];

describe('translation catalog', () => {
	it('resolves lazy contribution copy after the shell registers its bundle', () => {
		const contribution = {
			moduleId: 'catalog.core',
			translations: {
				en: { 'nav.label': 'Catalog' },
				pl: { 'nav.label': 'Katalog' },
			},
			get label() {
				return t('catalog.nav.label');
			},
		};
		registerModuleTranslations([contribution]);
		expect(contribution.label).toBe('Catalog');
	});

	it('merges every module bundle under its own namespace', () => {
		const catalog = createTranslationCatalog(SOURCES, 'pl', FALLBACK_LOCALE);
		expect(translateFrom(catalog, 'shell.account.signOut')).toBe('Wyloguj się');
		expect(translateFrom(catalog, 'catalog.list.title')).toBe('Katalog');
	});

	it('falls back to en, then to the key itself', () => {
		const catalog = createTranslationCatalog(SOURCES, 'pl', FALLBACK_LOCALE);
		expect(translateFrom(catalog, 'catalog.list.hint')).toBe(
			'Create the first product.',
		);
		expect(translateFrom(catalog, 'catalog.list.missing')).toBe(
			'catalog.list.missing',
		);
	});

	it('interpolates named parameters and keeps unknown ones visible', () => {
		const catalog = createTranslationCatalog(SOURCES, 'pl', FALLBACK_LOCALE);
		expect(translateFrom(catalog, 'catalog.list.count', { count: 4 })).toBe(
			'pozycje: 4',
		);
		expect(translateFrom(catalog, 'catalog.list.count', { other: 4 })).toBe(
			'pozycje: {count}',
		);
	});

	it('ignores a namespace that ships nothing for the active locale', () => {
		const catalog = createTranslationCatalog(
			[{ namespace: 'agents', bundles: { en: { 'run.title': 'Runs' } } }],
			'pl',
			FALLBACK_LOCALE,
		);
		expect(translateFrom(catalog, 'agents.run.title')).toBe('Runs');
	});
});

describe('plural selection', () => {
	const PLURALS: readonly TranslationSource[] = [
		{
			namespace: 'documents',
			bundles: {
				en: {
					'table.count.one': '{count} document',
					'table.count.other': '{count} documents',
					'rows.count.one': '{count} row',
					'rows.count.other': '{count} rows',
					'plain.count': '{count} kept',
				},
				pl: {
					'table.count.one': '{count} dokument',
					'table.count.few': '{count} dokumenty',
					'table.count.many': '{count} dokumentów',
					'table.count.other': '{count} dokumentu',
					'plain.count': 'Zapisano: {count}',
				},
			},
		},
	];

	it('picks the English one and other forms', () => {
		const catalog = createTranslationCatalog(PLURALS, 'en', FALLBACK_LOCALE);
		expect(translateFrom(catalog, 'documents.table.count', { count: 1 })).toBe(
			'1 document',
		);
		expect(translateFrom(catalog, 'documents.table.count', { count: 0 })).toBe(
			'0 documents',
		);
		expect(translateFrom(catalog, 'documents.table.count', { count: 5 })).toBe(
			'5 documents',
		);
	});

	it('picks the Polish one, few, many and other forms', () => {
		const catalog = createTranslationCatalog(PLURALS, 'pl', FALLBACK_LOCALE);
		const count = (value: number) =>
			translateFrom(catalog, 'documents.table.count', { count: value });
		expect(count(1)).toBe('1 dokument');
		expect(count(2)).toBe('2 dokumenty');
		expect(count(5)).toBe('5 dokumentów');
		expect(count(22)).toBe('22 dokumenty');
		expect(count(1.5)).toBe('1,5 dokumentu');
	});

	it('writes the count in the active locale number format', () => {
		const english = createTranslationCatalog(PLURALS, 'en', FALLBACK_LOCALE);
		const polish = createTranslationCatalog(PLURALS, 'pl', FALLBACK_LOCALE);
		expect(
			translateFrom(english, 'documents.table.count', { count: 12_345 }),
		).toBe('12,345 documents');
		expect(translateFrom(polish, 'documents.rows.count', { count: 12_345 })).toBe(
			'12\u00a0345 rows',
		);
	});

	it('falls back to the fallback locale family, then to the base key', () => {
		const catalog = createTranslationCatalog(PLURALS, 'pl', FALLBACK_LOCALE);
		expect(translateFrom(catalog, 'documents.rows.count', { count: 5 })).toBe(
			'5 rows',
		);
		expect(translateFrom(catalog, 'documents.plain.count', { count: 5 })).toBe(
			'Zapisano: 5',
		);
		expect(translateFrom(catalog, 'documents.missing', { count: 1 })).toBe(
			'documents.missing',
		);
	});

	it('uses other when the locale has no member for the selected category', () => {
		const catalog = createTranslationCatalog(
			[
				{
					namespace: 'documents',
					bundles: { en: {}, pl: { 'table.count.other': 'Dokumenty: {count}' } },
				},
			],
			'pl',
			FALLBACK_LOCALE,
		);
		expect(translateFrom(catalog, 'documents.table.count', { count: 5 })).toBe(
			'Dokumenty: 5',
		);
	});

	it('keeps a non-numeric count on the plain key', () => {
		const catalog = createTranslationCatalog(PLURALS, 'en', FALLBACK_LOCALE);
		expect(
			translateFrom(catalog, 'documents.table.count', { count: '1' }),
		).toBe('documents.table.count');
		expect(translateFrom(catalog, 'documents.plain.count', { count: '1' })).toBe(
			'1 kept',
		);
	});
});

describe('locale resolution', () => {
	const supported = ['en', 'pl'];

	it('prefers the tenant default over the fallback locale', () => {
		expect(resolveLocale({ tenantDefault: 'pl', supported })).toBe('pl');
		expect(resolveLocale({ supported })).toBe('en');
	});

	it('prefers the account choice over the tenant default', () => {
		expect(
			resolveLocale({ stored: 'en', tenantDefault: 'pl', supported }),
		).toBe('en');
	});

	it('ignores a locale nothing ships strings for', () => {
		expect(
			resolveLocale({ stored: 'de', tenantDefault: 'pl', supported }),
		).toBe('pl');
		expect(resolveLocale({ tenantDefault: 'de', supported })).toBe('en');
	});
});

describe('shell bundle', () => {
	it('ships identical key sets for every locale', () => {
		expect(translationKeys(shellPl)).toEqual(translationKeys(shellEn));
		expect(pluralFamilyIssues(shellEn, 'en')).toEqual([]);
		expect(pluralFamilyIssues(shellPl, 'pl')).toEqual([]);
	});

	it('names the built-in role and counts workspaces in the switcher line', () => {
		registerModuleTranslations([]);
		setActiveLocale('pl');
		const summary = (count: number) =>
			t('shell.org.summary', { role: t('shell.org.role.owner'), count });
		expect(summary(1)).toBe('Właściciel · 1 przestrzeń robocza');
		expect(summary(2)).toBe('Właściciel · 2 przestrzenie robocze');
		expect(summary(5)).toBe('Właściciel · 5 przestrzeni roboczych');
		setActiveLocale('en');
		expect(summary(2)).toBe('Owner · 2 workspaces');
	});

	it('translates every dynamic navigation group in every locale', () => {
		registerModuleTranslations([]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const group of [...NAVIGATION_GROUPS, 'Account' as const]) {
				expect(navigationGroupLabel(t, group)).not.toBe(
					'shell.nav.group.' + group.toLowerCase(),
				);
			}
			for (const option of SUPPORTED_LOCALES) {
				expect(t('shell.language.' + option)).not.toBe(
					'shell.language.' + option,
				);
			}
		}
		setActiveLocale('en');
	});
});
