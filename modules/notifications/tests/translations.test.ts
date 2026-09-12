import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { NOTIFICATION_KINDS } from '../src/domain/types.ts';
import { NOTIFICATIONS_MODULE_SETTINGS } from '../src/settings.ts';

describe('notifications translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('leaves no empty value in either locale', () => {
		for (const bundle of [translationsEn, translationsPl]) {
			for (const [key, value] of Object.entries(bundle)) {
				expect([key, typeof value === 'string' && value.length > 0]).toEqual([
					key,
					true,
				]);
			}
		}
	});

	it('names every notification kind in both locales', () => {
		for (const kind of NOTIFICATION_KINDS) {
			expect(`kind.${kind}` in translationsEn).toBe(true);
			expect(`kind.${kind}` in translationsPl).toBe(true);
		}
	});

	/* The preferences screen renders one row per kind and reads its help text by
	   the kind id, so a kind without one shows the raw key. */
	it('explains every notification kind on the preferences screen in both locales', () => {
		for (const kind of NOTIFICATION_KINDS) {
			expect([kind, `preferences.help.${kind}` in translationsEn]).toEqual([
				kind,
				true,
			]);
			expect([kind, `preferences.help.${kind}` in translationsPl]).toEqual([
				kind,
				true,
			]);
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(
			NOTIFICATIONS_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^notifications\./);
			expect(definition.descriptionKey).toMatch(/^notifications\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('notifications.'.length);
				expect([localKey, localKey in translationsEn]).toEqual([
					localKey,
					true,
				]);
				expect([localKey, localKey in translationsPl]).toEqual([
					localKey,
					true,
				]);
			}
		}
	});
});
