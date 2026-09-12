import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { DOCUMENT_SCANS } from '../src/domain/types.ts';
import { DOCUMENTS_MODULE_SETTINGS } from '../src/settings.ts';

const BUNDLES = [translationsEn, translationsPl] as const;

/* Every stable refusal the screen shows a reader has to have a sentence in both
   locales; without one the raw code reaches the screen. */
const ERROR_CODES = [
	'QUOTA_EXCEEDED',
	'DOCUMENT_TOO_LARGE',
	'CONTENT_TYPE_REFUSED',
	'CONTENT_MISMATCH',
	'DOCUMENT_INFECTED',
	'DOCUMENT_NOT_FOUND',
	'DOCUMENT_DELETED',
	'STORAGE_UNAVAILABLE',
] as const;

describe('documents translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('leaves no empty value in either locale', () => {
		for (const bundle of BUNDLES) {
			for (const [key, value] of Object.entries(bundle)) {
				expect([key, typeof value === 'string' && value.length > 0]).toEqual([
					key,
					true,
				]);
			}
		}
	});

	it('names every scan verdict in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const scan of DOCUMENT_SCANS) {
				expect([scan, `scan.${scan}` in bundle]).toEqual([scan, true]);
			}
		}
	});

	it('explains every refusal a reader can meet in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const code of ERROR_CODES) {
				expect([code, `error.code.${code}` in bundle]).toEqual([code, true]);
			}
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(
			DOCUMENTS_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^documents\./);
			expect(definition.descriptionKey).toMatch(/^documents\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('documents.'.length);
				for (const bundle of BUNDLES) {
					expect([localKey, localKey in bundle]).toEqual([localKey, true]);
				}
			}
		}
	});
});
