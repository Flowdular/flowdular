import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import type { SettingsEntryPayload } from '../src/server/endpoints.ts';
import { translateSettingCopy } from '../src/client/setting-copy.ts';

const setting: SettingsEntryPayload = {
	key: 'workerConcurrency',
	type: 'number',
	scope: 'platform',
	label: 'Worker concurrency',
	labelKey: 'agents.settings.workerConcurrency.label',
	description: 'Maximum concurrent runs.',
	descriptionKey: 'agents.settings.workerConcurrency.description',
	locked: 'This setting is locked.',
	lockedKey: 'system.settings.locked',
	value: 2,
	hasValue: false,
	defaultValue: 2,
	secret: false,
};

describe('module setting copy', () => {
	it('resolves server-provided keys in the active locale', () => {
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: {
					en: {
						'settings.workerConcurrency.label': 'Concurrent runs',
						'settings.workerConcurrency.description':
							'Maximum concurrent runs.',
					},
					pl: {
						'settings.workerConcurrency.label': 'Równoległe uruchomienia',
						'settings.workerConcurrency.description':
							'Maksymalna liczba równoległych uruchomień.',
					},
				},
			},
			{
				moduleId: 'system.core',
				translations: {
					en: { 'settings.locked': 'This setting is unavailable.' },
					pl: { 'settings.locked': 'To ustawienie jest zablokowane.' },
				},
			},
		]);
		setActiveLocale('pl');
		expect(translateSettingCopy(setting)).toEqual({
			label: 'Równoległe uruchomienia',
			description: 'Maksymalna liczba równoległych uruchomień.',
			locked: 'To ustawienie jest zablokowane.',
		});
		setActiveLocale('en');
		expect(translateSettingCopy(setting).label).toBe('Concurrent runs');
	});

	it('keeps legacy literals when keys are absent or unresolved', () => {
		const legacy: SettingsEntryPayload = {
			key: setting.key,
			type: setting.type,
			scope: setting.scope,
			label: setting.label,
			labelKey: 'agents.settings.missing.label',
			description: setting.description,
			locked: 'This setting is locked.',
			value: setting.value,
			hasValue: setting.hasValue,
			defaultValue: setting.defaultValue,
			secret: setting.secret,
		};
		expect(translateSettingCopy(legacy, (key) => key)).toEqual({
			label: 'Worker concurrency',
			description: 'Maximum concurrent runs.',
			locked: 'This setting is locked.',
		});
	});
});
