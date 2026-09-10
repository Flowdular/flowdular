import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { AUTOMATIONS_MODULE_SETTINGS } from '../src/settings.ts';

describe('automations translations', () => {
	it('ships matching English and Polish keys', async () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('translates every declared module setting label and description', async () => {
		for (const definition of Object.values(
			AUTOMATIONS_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^automations\./);
			expect(definition.descriptionKey).toMatch(/^automations\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('automations.'.length);
				expect(localKey in translationsEn).toBe(true);
				expect(localKey in translationsPl).toBe(true);
			}
		}
	});
});
