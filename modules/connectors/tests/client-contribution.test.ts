import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { CONNECTORS_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	CONNECTORS_VIEWS,
	connectorsNavigation,
} from '../src/client/navigation.ts';

const LOCALES = ['en', 'pl'];

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'connectors.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

describe('connectors client contribution', () => {
	it('registers both screens under Administration behind the read permission', () => {
		expect(
			connectorsNavigation.map((entry) => [
				entry.id,
				entry.viewId,
				entry.group,
				entry.scope,
			]),
		).toEqual([
			[
				'connectors.navigation.instances',
				CONNECTORS_VIEWS.instances,
				'Administration',
				CONNECTORS_PERMISSIONS.read,
			],
			[
				'connectors.navigation.calls',
				CONNECTORS_VIEWS.calls,
				'Administration',
				CONNECTORS_PERMISSIONS.read,
			],
		]);
	});

	/* A navigation entry pointing at a view the contribution does not register
	   throws when the shell boots, and both read the ids from this one set. */
	it('points every entry at a declared view id, each used once', () => {
		const declared = Object.values(CONNECTORS_VIEWS);
		expect(new Set(declared).size).toBe(declared.length);
		const used = connectorsNavigation.map((entry) => entry.viewId);
		expect(new Set(used).size).toBe(used.length);
		for (const entry of connectorsNavigation) {
			expect([entry.id, declared.includes(entry.viewId as never)]).toEqual([
				entry.id,
				true,
			]);
		}
	});

	it('names every entry in both locales', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const entry of connectorsNavigation) {
				expect([locale, entry.id, entry.label.length > 0]).toEqual([
					locale,
					entry.id,
					true,
				]);
				expect([
					locale,
					entry.id,
					(entry.description ?? '').length > 0,
				]).toEqual([locale, entry.id, true]);
			}
		}
		setActiveLocale('en');
	});

	/* Every literal key the screens ask for. A key renamed on one side renders
	   as the raw key on screen, and nothing else would catch it. */
	it('resolves every literal key the screens ask for', () => {
		const clientDirectory = fileURLToPath(
			new URL('../src/client/', import.meta.url),
		);
		const keys = new Set<string>();
		for (const entry of readdirSync(clientDirectory)) {
			if (!entry.endsWith('.tsrx') && !entry.endsWith('.ts')) continue;
			const source = readFileSync(join(clientDirectory, entry), 'utf8');
			for (const match of source.matchAll(
				/\bt\s*\(\s*'(connectors\.[a-zA-Z0-9._-]+)'/g,
			)) {
				keys.add(match[1]!);
			}
		}
		expect(keys.size).toBeGreaterThan(50);

		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of keys) {
				/* A trailing dot is a prefix the screen completes at run time; the
				   closed sets are covered by the translations suite. */
				if (key.endsWith('.')) continue;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});
});
