import { describe, expect, it } from 'vitest';
import { landingCopy } from '../src/landing.copy.ts';
import {
	FALLBACK_LOCALE,
	isLandingLocale,
	LANDING_LOCALES,
} from '../src/locale.ts';

function paths(value: unknown, prefix = ''): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry, index) =>
			paths(entry, prefix + '[' + String(index) + ']'),
		);
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, entry]) =>
			paths(entry, prefix ? prefix + '.' + key : key),
		);
	}
	return [prefix];
}

describe('landing copy', () => {
	it('ships the same shape for every locale', () => {
		const reference = paths(landingCopy(FALLBACK_LOCALE)).sort();
		for (const locale of LANDING_LOCALES) {
			expect(paths(landingCopy(locale)).sort()).toEqual(reference);
		}
	});

	it('never renders an empty string', () => {
		for (const locale of LANDING_LOCALES) {
			const empty = Object.entries(flatten(landingCopy(locale))).filter(
				([, value]) => value.trim() === '',
			);
			expect(empty).toEqual([]);
		}
	});

	it('recognizes only the locales it ships', () => {
		expect(isLandingLocale('en')).toBe(true);
		expect(isLandingLocale('pl')).toBe(true);
		expect(isLandingLocale('de')).toBe(false);
	});
});

function flatten(value: unknown, prefix = ''): Record<string, string> {
	if (typeof value === 'string') return { [prefix]: value };
	if (Array.isArray(value)) {
		return Object.assign(
			{},
			...value.map((entry, index) =>
				flatten(entry, prefix + '[' + String(index) + ']'),
			),
		) as Record<string, string>;
	}
	if (value && typeof value === 'object') {
		return Object.assign(
			{},
			...Object.entries(value).map(([key, entry]) =>
				flatten(entry, prefix ? prefix + '.' + key : key),
			),
		) as Record<string, string>;
	}
	return {};
}
