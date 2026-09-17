import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { translationKeys } from '@flowdular/contracts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { adaptersNavigation } from '../src/client/navigation.ts';
import {
	ADAPTER_DIRECTIONS,
	ADAPTER_TRANSFORMS,
} from '../src/domain/registry.ts';
import {
	ADAPTER_ROW_OUTCOMES,
	ADAPTER_RUN_STATUSES,
	ADAPTER_RUN_TRIGGERS,
} from '../src/domain/types.ts';

const BUNDLES = [translationsEn, translationsPl] as const;

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

const SOURCE = sourceText(fileURLToPath(new URL('../src', import.meta.url)));

/* Every stable code this module can record or answer, read out of the source
   so a code added without copy fails here. */
const CODES = [
	...new Set(
		[...SOURCE.matchAll(/'((?:ADAPTER|MAPPING)_[A-Z_]+)'/g)].map(
			(match) => match[1]!,
		),
	),
].sort();

describe('adapters translations', () => {
	it('reads the module’s codes out of its source', () => {
		expect(CODES.length).toBeGreaterThanOrEqual(30);
	});

	it('ships matching English and Polish keys with no empty value', () => {
		expect(translationKeys(translationsPl)).toEqual(
			translationKeys(translationsEn),
		);
		for (const bundle of BUNDLES) {
			for (const [key, value] of Object.entries(bundle)) {
				expect([key, typeof value === 'string' && value.length > 0]).toEqual([
					key,
					true,
				]);
			}
		}
	});

	it('explains every code and names every status, trigger, outcome, direction and rule', () => {
		const keys = [
			...CODES.map((code) => `error.code.${code}`),
			...ADAPTER_RUN_STATUSES.map((status) => `status.${status}`),
			...ADAPTER_RUN_TRIGGERS.map((trigger) => `trigger.${trigger}`),
			...ADAPTER_ROW_OUTCOMES.map((outcome) => `outcome.${outcome}`),
			'outcome.valid',
			...ADAPTER_DIRECTIONS.map((direction) => `direction.${direction}`),
			...ADAPTER_TRANSFORMS.map((transform) => `transform.${transform}`),
			'mapping.value.constant',
			'mapping.value.format',
			'mapping.value.lookup',
		];
		for (const bundle of BUNDLES) {
			for (const key of keys) {
				expect([key, key in bundle]).toEqual([key, true]);
			}
		}
	});

	it('places the screen in Administration, section integrations', () => {
		expect(
			adaptersNavigation.map((entry) => [
				entry.viewId,
				entry.group,
				entry.section,
			]),
		).toEqual([['data-adapters', 'Administration', 'integrations']]);
	});

	it('uses only keys the bundles carry', () => {
		const used = [...SOURCE.matchAll(/t\(\s*'adapters\.([a-zA-Z.]+)'/g)].map(
			(match) => match[1]!,
		);
		/* A key ending in a dot is a family completed at run time; the case
		   above names every member of each. */
		const known = translationKeys(translationsEn);
		for (const key of new Set(used.filter((entry) => !entry.endsWith('.')))) {
			expect([key, known.includes(key)]).toEqual([key, true]);
		}
	});
});
