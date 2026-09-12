import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { accessNavigation } from '../src/client/navigation.ts';
import { ACTION_CATEGORIES } from '../src/services/changes.ts';

describe('access translations', () => {
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

	/* A navigation entry reads its label every render, so a key it cannot
	   resolve shows the raw key in the sidebar. */
	it('translates every navigation entry in both locales', () => {
		expect(accessNavigation.map((entry) => entry.viewId)).toEqual([
			'access-review',
			'access-activity',
			'access-attestations',
		]);
		for (const entry of accessNavigation) {
			const key = entry.id.replace('access.', '');
			for (const suffix of ['', 'Description']) {
				expect([key + suffix, key + suffix in translationsEn]).toEqual([
					key + suffix,
					true,
				]);
				expect([key + suffix, key + suffix in translationsPl]).toEqual([
					key + suffix,
					true,
				]);
			}
		}
	});

	/* Every category a report can answer is a label on the screen. */
	it('names every change category in both locales', () => {
		for (const category of new Set(Object.values(ACTION_CATEGORIES))) {
			const key = `category.${category}`;
			expect([key, key in translationsEn]).toEqual([key, true]);
			expect([key, key in translationsPl]).toEqual([key, true]);
		}
	});
});
