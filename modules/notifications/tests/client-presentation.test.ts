import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	deliveryCompletedLabel,
	timestampLabel,
} from '../src/client/presentation.ts';

const COMPLETED_AT = Date.UTC(2026, 8, 11, 7, 12);

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'notifications.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterAll(() => {
	setActiveLocale('en');
});

/* Scheduled and completed share one cell, so the second line has to say which
   time it is on its own. */
describe('delivery timing cell', () => {
	it('names the completion beside the time it happened', () => {
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			const label = deliveryCompletedLabel(COMPLETED_AT);
			expect([locale, label.includes(timestampLabel(COMPLETED_AT))]).toEqual([
				locale,
				true,
			]);
			expect([locale, label.trim() === timestampLabel(COMPLETED_AT)]).toEqual([
				locale,
				false,
			]);
		}
	});

	it('says an attempt has not completed instead of leaving the line blank', () => {
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			const label = deliveryCompletedLabel(null);
			expect([locale, label.length > 0]).toEqual([locale, true]);
			expect([locale, label.includes('{')]).toEqual([locale, false]);
			expect([locale, label]).not.toEqual([
				locale,
				deliveryCompletedLabel(COMPLETED_AT),
			]);
		}
	});
});
