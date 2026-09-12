import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { DIRECTORY_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	DIRECTORY_REASONS,
	PROVISIONING_OPERATIONS,
	PROVISIONING_OUTCOMES,
	SCIM_TOKEN_STATUSES,
} from '../src/domain/types.ts';
import {
	directoryNavigation,
	DIRECTORY_VIEWS,
} from '../src/client/navigation.ts';

const LOCALES = ['en', 'pl'];

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'directory.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

describe('directory client contribution', () => {
	it('puts every screen in Administration behind the right permission', () => {
		expect(
			directoryNavigation.map((entry) => [
				entry.id,
				entry.viewId,
				entry.group,
				entry.scope,
			]),
		).toEqual([
			[
				'directory.navigation.tokens',
				DIRECTORY_VIEWS.tokens,
				'Administration',
				DIRECTORY_PERMISSIONS.read,
			],
			[
				'directory.navigation.groups',
				DIRECTORY_VIEWS.groups,
				'Administration',
				DIRECTORY_PERMISSIONS.provisioningRead,
			],
			[
				'directory.navigation.log',
				DIRECTORY_VIEWS.log,
				'Administration',
				DIRECTORY_PERMISSIONS.provisioningRead,
			],
		]);
	});

	/* Duplicate ids and an entry pointing at a view nobody registered both throw
	   when the shell boots, so they are checked here instead. */
	it('registers one entry per view and no duplicate id', () => {
		const ids = directoryNavigation.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const viewIds = directoryNavigation.map((entry) => entry.viewId);
		expect(new Set(viewIds).size).toBe(viewIds.length);
		expect(viewIds.sort()).toEqual([...Object.values(DIRECTORY_VIEWS)].sort());
	});

	it('reads its labels through the active locale', () => {
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const entry of directoryNavigation) {
				expect([locale, entry.id, entry.label]).not.toContain(
					'directory.navigation',
				);
				expect([locale, entry.id, entry.description ?? '']).not.toEqual([
					locale,
					entry.id,
					'',
				]);
			}
		}
		setActiveLocale('en');
		const english = directoryNavigation[0]!.label;
		setActiveLocale('pl');
		expect(directoryNavigation[0]!.label).not.toBe(english);
	});
});

describe('directory client copy', () => {
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
				/\bt\s*\(\s*'(directory\.[a-zA-Z0-9._-]+)'/g,
			)) {
				keys.add(match[1]!);
			}
		}
		expect(keys.size).toBeGreaterThan(60);

		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of keys) {
				/* A trailing dot is a prefix the screen completes at run time; the
				   closed sets below cover those. */
				if (key.endsWith('.')) continue;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});

	it('names every value of every closed set the screens render', () => {
		const dynamic = [
			...PROVISIONING_OPERATIONS.map(
				(operation) => 'directory.log.operation.' + operation,
			),
			...PROVISIONING_OUTCOMES.map(
				(outcome) => 'directory.log.outcome.' + outcome,
			),
			...SCIM_TOKEN_STATUSES.map(
				(status) => 'directory.tokens.status.' + status,
			),
			...Object.values(DIRECTORY_REASONS).map(
				(reason) => 'directory.reason.' + reason,
			),
		];
		for (const locale of LOCALES) {
			setActiveLocale(locale);
			for (const key of dynamic) {
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});
});
