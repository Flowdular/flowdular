import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { SEARCH_MODULE_SETTINGS } from '../src/settings.ts';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

function moduleSource(): string {
	const parts: string[] = [];
	for (const entry of readdirSync(SOURCE_ROOT, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (entry.isFile()) {
			parts.push(readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8'));
		}
	}
	return parts.join('\n');
}

describe('search translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	/* Copy no screen can reach is still translated, reviewed and kept in step
	   for every locale, so an orphan key is removed rather than carried. */
	it('ships no key the module never reaches', () => {
		const source = moduleSource();
		for (const key of Object.keys(translationsEn)) {
			/* Built from the server's stable code at the point of failure. */
			if (key.startsWith('error.code.')) continue;
			/* Read by the platform module list, not by this module. */
			if (key === 'module.name') continue;
			expect([key, source.includes(key)]).toEqual([key, true]);
		}
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

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(SEARCH_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^search\./);
			expect(definition.descriptionKey).toMatch(/^search\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('search.'.length);
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

	/* A screen that meets one of these codes shows translated copy; anything
	   else falls back to the server sentence, which is written for an operator. */
	it('translates every stable code the screens can meet', () => {
		for (const code of ['QUERY_TOO_LONG', 'CURSOR_INVALID', 'INVALID_INPUT']) {
			expect([code, `error.code.${code}` in translationsEn]).toEqual([
				code,
				true,
			]);
			expect([code, `error.code.${code}` in translationsPl]).toEqual([
				code,
				true,
			]);
		}
	});
});
