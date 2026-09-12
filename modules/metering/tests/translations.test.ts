import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { METER_KINDS } from '../src/domain/types.ts';
import { METERING_MODULE_SETTINGS } from '../src/settings.ts';
import { meteringNavigation } from '../src/client/navigation.ts';

describe('metering translations', () => {
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

	it('names every meter kind in both locales', () => {
		for (const kind of METER_KINDS) {
			expect([kind, `kind.${kind}` in translationsEn]).toEqual([kind, true]);
			expect([kind, `kind.${kind}` in translationsPl]).toEqual([kind, true]);
		}
	});

	/* A navigation entry reads its label every render, so a key it cannot
	   resolve shows the raw key in the sidebar. */
	it('translates every navigation entry in both locales', () => {
		expect(meteringNavigation.map((entry) => entry.viewId)).toEqual([
			'metering-usage',
			'metering-limits',
		]);
		for (const key of [
			'navigation.usage',
			'navigation.usageDescription',
			'navigation.limits',
			'navigation.limitsDescription',
		]) {
			expect([key, key in translationsEn]).toEqual([key, true]);
			expect([key, key in translationsPl]).toEqual([key, true]);
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(METERING_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^metering\./);
			expect(definition.descriptionKey).toMatch(/^metering\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('metering.'.length);
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
