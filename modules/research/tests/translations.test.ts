import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	researchNavigation,
	evidenceIdFromLocation,
} from '../src/client/navigation.ts';
import { RESEARCH_MODULE_SETTINGS } from '../src/settings.ts';

describe('research translations', () => {
	it('ships matching English and Polish keys with no empty value', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		for (const bundle of [translationsEn, translationsPl]) {
			for (const [key, value] of Object.entries(bundle)) {
				expect([key, typeof value === 'string' && value.length > 0]).toEqual([
					key,
					true,
				]);
			}
		}
	});

	it('translates the navigation entry and every setting in both locales', () => {
		expect(
			researchNavigation.map((entry) => [entry.viewId, entry.section]),
		).toEqual([['research', 'compliance']]);
		const keys = [
			'navigation.research',
			'navigation.researchDescription',
			...Object.values(RESEARCH_MODULE_SETTINGS.settings).flatMap(
				(definition) => [
					definition.labelKey!.replace('research.', ''),
					definition.descriptionKey!.replace('research.', ''),
				],
			),
		];
		for (const key of keys) {
			expect([key, key in translationsEn, key in translationsPl]).toEqual([
				key,
				true,
				true,
			]);
		}
	});

	it('reads the evidence id another module links to from the address', () => {
		expect(evidenceIdFromLocation('?id=abc')).toBe('abc');
		expect(evidenceIdFromLocation('?id=')).toBeNull();
		expect(evidenceIdFromLocation('')).toBeNull();
	});
});
