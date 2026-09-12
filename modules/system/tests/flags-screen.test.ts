import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { flagCount, flagGroups } from '../src/client/flags.ts';
import { workspaceViewHref } from '@flowdular/client/routing';
import { AUDIT_VIEW_ID, FLAG_AUDIT_ACTION } from '../src/client/navigation.ts';
import type { SettingsModulePayload } from '../src/server/endpoints.ts';

const LOCALES = ['en', 'pl'];

function setting(
	key: string,
	overrides: Partial<SettingsModulePayload['settings'][number]> = {},
): SettingsModulePayload['settings'][number] {
	return {
		key,
		type: 'boolean',
		scope: 'tenant',
		label: key,
		description: '',
		value: false,
		hasValue: false,
		defaultValue: false,
		secret: false,
		...overrides,
	};
}

const listing: readonly SettingsModulePayload[] = [
	{
		moduleId: 'documents.core',
		name: 'Documents Core',
		description: '',
		settings: [
			setting('maxUploadMb', { type: 'number', value: 25, defaultValue: 25 }),
			setting('bulkUpload', { kind: 'flag' }),
			setting('inlinePreview', { kind: 'flag', value: true, hasValue: true }),
		],
	},
	{
		moduleId: 'auth.core',
		name: 'Authentication Core',
		description: '',
		settings: [setting('allowSignUp', { scope: 'platform', value: true })],
	},
	{
		moduleId: 'search.core',
		name: 'Search Core',
		description: '',
		settings: [setting('semanticRanking', { kind: 'flag' })],
	},
];

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'system.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

describe('flags screen', () => {
	it('keeps only declared flags and groups them by their owning module', () => {
		const groups = flagGroups(listing);
		expect(
			groups.map((group) => [
				group.moduleId,
				group.flags.map((flag) => flag.key),
			]),
		).toEqual([
			['documents.core', ['bulkUpload', 'inlinePreview']],
			['search.core', ['semanticRanking']],
		]);
		expect(flagCount(groups)).toBe(3);
	});

	/* The empty state is what a workspace whose modules declare no flag must
	   see; a module whose only settings are plain must not produce a heading
	   with nothing under it. */
	it('reports no group when no module declares a flag', () => {
		const plain = listing.filter((module) => module.moduleId === 'auth.core');
		expect(flagGroups(plain)).toEqual([]);
		expect(flagCount(flagGroups(plain))).toBe(0);
		expect(flagGroups([])).toEqual([]);
	});

	/* The panel renders inside the modules view, so the audit link has to carry
	   the installation path and the workspace the reader is in. */
	it('links to the audit trail in the open workspace', () => {
		expect(
			workspaceViewHref(AUDIT_VIEW_ID, '/app/northwind/modules', '/app'),
		).toBe('/app/northwind/audit');
		expect(workspaceViewHref(AUDIT_VIEW_ID, '/app/modules', '/app')).toBe(
			'/app/audit',
		);
		expect(workspaceViewHref(AUDIT_VIEW_ID, '', '/workspace')).toBe(
			'/workspace/audit',
		);
	});

	it('names the audited action the reviewer filters the trail by', () => {
		expect(FLAG_AUDIT_ACTION).toBe('settings.flag.changed');
		expect(
			t('system.flags.auditNote', { action: FLAG_AUDIT_ACTION }),
		).toContain(FLAG_AUDIT_ACTION);
	});

	/* Loading, empty, error, populated and denied each have their own copy; a
	   missing locale would show the raw key on the screen. */
	it('translates every state of the screen in every locale', () => {
		const keys = [
			'system.tab.label',
			'system.tab.catalog',
			'system.tab.flags',
			'system.flags.title',
			'system.flags.loading',
			'system.flags.loadingHint',
			'system.flags.emptyTitle',
			'system.flags.emptyHint',
			'system.flags.deniedTitle',
			'system.flags.deniedHint',
			'system.flags.deniedManage',
			'system.flags.auditLink',
			'system.settings.errorLoad',
			'system.settings.errorSave',
		];
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of keys) {
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});
});
