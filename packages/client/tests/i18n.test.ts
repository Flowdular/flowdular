import { describe, expect, it } from 'vitest';
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
		expect(Object.keys(shellPl).sort()).toEqual(Object.keys(shellEn).sort());
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
