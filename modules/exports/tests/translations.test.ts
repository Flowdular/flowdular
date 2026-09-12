import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	EXPORT_JOB_STATUSES,
	EXPORT_UNEXPECTED_FAILURE,
} from '../src/domain/types.ts';
import { EXPORTS_MODULE_SETTINGS } from '../src/settings.ts';

const BUNDLES = [translationsEn, translationsPl] as const;

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const PLATFORM_EXPORT = fileURLToPath(
	new URL('../../../packages/server/src/export/definition.ts', import.meta.url),
);

function sourceText(directory: string): string {
	let text = '';
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		text += entry.isDirectory()
			? sourceText(path)
			: `${readFileSync(path, 'utf8')}\n`;
	}
	return text;
}

const SOURCE = sourceText(SOURCE_ROOT);

function codesMatching(text: string, pattern: RegExp): readonly string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(pattern)) found.add(match[1]!);
	return [...found].sort();
}

/**
 * Every stable code this module constructs, plus the ones the platform export
 * driver records on a job through `failureCodeOf`. A refused request answers
 * with one and the screen reads it as `error.code.<code>`, so the list is read
 * out of the source rather than kept by hand: a code added without copy fails
 * here.
 */
const ERROR_CODES = [
	...codesMatching(SOURCE, /new [A-Za-z]*Error\(\s*'([A-Z][A-Z0-9_]*)'/g),
	...codesMatching(SOURCE, /\bfailureCode: '([A-Z][A-Z0-9_]*)'/g),
	...codesMatching(SOURCE, /this\.#fail\(job, '([A-Z][A-Z0-9_]*)'\)/g),
	...codesMatching(
		readFileSync(PLATFORM_EXPORT, 'utf8'),
		/^\t\| '(EXPORT_[A-Z0-9_]*)'/gm,
	),
	EXPORT_UNEXPECTED_FAILURE,
];

describe('exports translations', () => {
	it('reads the codes a job can carry out of the source', () => {
		/* A scan that stopped matching would pass every case below without
		   checking anything, so the count is asserted before it is used. */
		expect(new Set(ERROR_CODES).size).toBeGreaterThanOrEqual(14);
		expect(ERROR_CODES).toContain('EXPORT_ROWS_EXCEEDED');
		expect(ERROR_CODES).toContain('EXPORT_LIST_FORBIDDEN');
	});

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

	it('names every job status in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const status of EXPORT_JOB_STATUSES) {
				expect([status, `status.${status}` in bundle]).toEqual([status, true]);
			}
		}
	});

	it('explains every code a request or a job can carry in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const code of ERROR_CODES) {
				expect([code, `error.code.${code}` in bundle]).toEqual([code, true]);
			}
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(EXPORTS_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^exports\./);
			expect(definition.descriptionKey).toMatch(/^exports\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('exports.'.length);
				for (const bundle of BUNDLES) {
					expect([localKey, localKey in bundle]).toEqual([localKey, true]);
				}
			}
		}
	});
});
