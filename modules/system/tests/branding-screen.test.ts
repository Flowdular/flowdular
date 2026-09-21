import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import {
	BRANDING_SETTING_KEYS,
	DEFAULT_APPLICATION_BRANDING,
} from '@flowdular/contracts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { brandingOf, brandingSettings } from '../src/client/branding.ts';
import { SYSTEM_MODULE_SETTINGS } from '../src/settings.ts';
import type { SettingsEntryPayload } from '../src/server/endpoints.ts';

const LOCALES = ['en', 'pl'];

function setting(
	key: string,
	value: string,
	overrides: Partial<SettingsEntryPayload> = {},
): SettingsEntryPayload {
	return {
		key,
		type: 'string',
		scope: 'platform',
		label: key,
		description: '',
		value,
		hasValue: true,
		defaultValue: '',
		secret: false,
		...overrides,
	};
}

describe('Branding screen', () => {
	/* SYSTEM-BRANDING-READ: the screen's own order, not the module's, and
	   nothing the running platform does not declare. */
	it('lists the branding rows in reading order and drops the rest', () => {
		const rows = brandingSettings([
			setting('timeZone', 'Europe/Warsaw'),
			setting('ogImageUrl', '/og.png'),
			setting('appName', 'Acme'),
			setting('themeColor', '#0B5FFF'),
		]);
		expect(rows.map((row) => row.key)).toEqual([
			'appName',
			'themeColor',
			'ogImageUrl',
		]);
	});

	it('previews the stored values and falls back per field', () => {
		const preview = brandingOf([
			setting('appName', 'Acme Operations'),
			setting('logoUrl', 'javascript:alert(1)'),
			setting('themeColor', '#0B5FFF'),
		]);
		expect(preview.appName).toBe('Acme Operations');
		expect(preview.themeColor).toBe('#0B5FFF');
		expect(preview.logoUrl).toBe(DEFAULT_APPLICATION_BRANDING.logoUrl);
		expect(preview.faviconUrl).toBe(DEFAULT_APPLICATION_BRANDING.faviconUrl);
	});

	it('declares every key the screen renders', () => {
		for (const key of BRANDING_SETTING_KEYS) {
			expect(SYSTEM_MODULE_SETTINGS.settings[key]).toBeDefined();
			expect(SYSTEM_MODULE_SETTINGS.settings[key]!.scope).toBe('platform');
			expect(SYSTEM_MODULE_SETTINGS.settings[key]!.client).toBe(true);
		}
	});
});

describe('Branding copy', () => {
	beforeAll(() => {
		registerModuleTranslations([
			{
				moduleId: 'system.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
	});

	afterAll(() => {
		setActiveLocale('en');
	});

	it.each(LOCALES)('translates the screen and every label in %s', (locale) => {
		setActiveLocale(locale);
		const keys = [
			'system.navigation.branding',
			'system.navigation.brandingDescription',
			'system.branding.page.title',
			'system.branding.page.description',
			'system.branding.title',
			'system.branding.allWorkspaces',
			'system.branding.deniedManage',
			'system.branding.reloadNote',
			'system.branding.denied.title',
			'system.branding.denied.hint',
			'system.branding.loading',
			'system.branding.loadingHint',
			'system.branding.emptyTitle',
			'system.branding.emptyHint',
			'system.branding.preview.imageAlt',
			...BRANDING_SETTING_KEYS.flatMap((key) => {
				const definition = SYSTEM_MODULE_SETTINGS.settings[key]!;
				return [definition.labelKey!, definition.descriptionKey!];
			}),
		];
		for (const key of keys) expect(t(key)).not.toBe(key);
		expect(
			t('system.branding.preview.tab', { title: 'Workspace · Acme' }),
		).toContain('Workspace · Acme');
	});
});
