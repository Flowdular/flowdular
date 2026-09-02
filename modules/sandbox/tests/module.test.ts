import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import { moduleDefinition, SANDBOX_PERMISSIONS } from '../src/index.ts';
import { endpoints } from '../src/api/endpoints.ts';
import catalog from '../src/cli/commands.json' with { type: 'json' };
import { cliExtension } from '../src/cli/index.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

describe('sandbox.core', () => {
	it('ships complete dynamic state and capability translations', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		registerModuleTranslations([
			{
				moduleId: 'sandbox.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const state of [
				'draft',
				'classified',
				'planned',
				'editing',
				'validating',
				'previewing',
				'awaiting-approval',
				'accepted',
				'failed',
				'blocked',
				'archived',
				'deleted',
			]) {
				const key = 'sandbox.sessionState.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const state of ['active', 'expired', 'revoked']) {
				const key = 'sandbox.grantState.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const capability of [
				'sandbox.access.use',
				'sandbox.sessions.read',
				'sandbox.preview.data',
				'sandbox.modules.eject',
			]) {
				const key = 'sandbox.capability.' + capability;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('sandbox.core');
		expect(moduleDefinition.permissions).toContain(SANDBOX_PERMISSIONS.use);
	});

	it('registers every declared endpoint id once', () => {
		expect(new Set(endpoints).size).toBe(endpoints.length);
	});

	it('keeps the CLI implementation metadata-identical to its catalog', () => {
		expect(cliExtension.moduleId).toBe(catalog.moduleId);
		const declared = catalog.commands.map((command) => ({
			path: command.path,
			capability: command.capability,
		}));
		const implemented = cliExtension.commands.map((command) => ({
			path: [...command.path],
			capability: command.capability,
		}));
		expect(implemented).toEqual(declared);
	});
});
