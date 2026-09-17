import { describe, expect, it } from 'vitest';
import { translationKeys } from '@flowdular/contracts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	DOCUMENT_TEXT_REASONS,
	DOCUMENT_TEXT_STATUSES,
} from '../src/domain/text.ts';
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
	'DOCUMENT_TEXT_NOT_RETRYABLE',
	'TEMPLATE_NOT_FOUND',
	'TEMPLATE_INVALID',
	'TEMPLATE_INPUT_INVALID',
	'TEMPLATE_VERSION_CONFLICT',
	'TEMPLATE_UNCHANGED',
	'TEMPLATE_VALUE_INVALID',
	'TEMPLATE_ROWS_EXCEEDED',
	'TEMPLATE_OUTPUT_TOO_LARGE',
	'TEMPLATE_PAGES_EXCEEDED',
	'TEMPLATE_VERSION_NOT_FOUND',
	'TEMPLATE_PREVIEW_BUSY',
] as const;

describe('documents translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(translationKeys(translationsPl)).toEqual(
			translationKeys(translationsEn),
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

	it('names every text status and reason in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const status of DOCUMENT_TEXT_STATUSES) {
				expect([status, `text.status.${status}` in bundle]).toEqual([
					status,
					true,
				]);
			}
			for (const reason of DOCUMENT_TEXT_REASONS) {
				expect([reason, `text.reason.${reason}` in bundle]).toEqual([
					reason,
					true,
				]);
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
