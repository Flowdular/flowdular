import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { IMPORT_FIELD_TYPES, IMPORT_MODES } from '../src/domain/ports.ts';
import {
	IMPORT_JOB_STATUSES,
	IMPORT_ROW_OUTCOMES,
	IMPORT_UNEXPECTED_FAILURE,
} from '../src/domain/types.ts';
import { IMPORT_MODULE_SETTINGS } from '../src/settings.ts';

const BUNDLES = [translationsEn, translationsPl] as const;

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));

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

function codesMatching(pattern: RegExp): readonly string[] {
	const found = new Set<string>();
	for (const match of SOURCE.matchAll(pattern)) found.add(match[1]!);
	return [...found].sort();
}

/**
 * Every stable code this module constructs. A refused request answers with one
 * and the screen reads it as `error.code.<code>`, so the list is read out of the
 * source rather than kept by hand: a code added without copy fails here.
 */
const ERROR_CODES = codesMatching(
	/new [A-Za-z]*Error\(\s*'([A-Z][A-Z0-9_]*)'/g,
);

/**
 * Every reason this module writes onto a row, plus the code a stage records when
 * the failure carries none of its own. A failure code that is also a request's
 * refusal reads that one sentence through `reasonLabel`, so it needs no second
 * copy of it here.
 */
const REASON_CODES = [
	...codesMatching(/\breason: '([A-Z][A-Z0-9_]*)'/g),
	IMPORT_UNEXPECTED_FAILURE,
];

describe('import translations', () => {
	it('reads the module’s own codes out of its source', () => {
		/* A scan that stopped matching would pass every case below without
		   checking anything, so the counts are asserted before they are used. */
		expect(ERROR_CODES.length).toBeGreaterThanOrEqual(20);
		expect(REASON_CODES.length).toBeGreaterThanOrEqual(7);
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

	it('names every status, outcome, mode and field type in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const status of IMPORT_JOB_STATUSES) {
				expect([status, `status.${status}` in bundle]).toEqual([status, true]);
			}
			for (const outcome of IMPORT_ROW_OUTCOMES) {
				expect([outcome, `outcome.${outcome}` in bundle]).toEqual([
					outcome,
					true,
				]);
			}
			for (const mode of IMPORT_MODES) {
				expect([mode, `mode.${mode}` in bundle]).toEqual([mode, true]);
			}
			for (const type of IMPORT_FIELD_TYPES) {
				expect([type, `type.${type}` in bundle]).toEqual([type, true]);
			}
		}
	});

	it('explains every code this module refuses with in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const code of ERROR_CODES) {
				expect([code, `error.code.${code}` in bundle]).toEqual([code, true]);
			}
		}
	});

	it('explains every reason it writes onto a row or a job in both locales', () => {
		for (const bundle of BUNDLES) {
			for (const code of REASON_CODES) {
				expect([code, `reason.${code}` in bundle]).toEqual([code, true]);
			}
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(IMPORT_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^import\./);
			expect(definition.descriptionKey).toMatch(/^import\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('import.'.length);
				for (const bundle of BUNDLES) {
					expect([localKey, localKey in bundle]).toEqual([localKey, true]);
				}
			}
		}
	});
});
