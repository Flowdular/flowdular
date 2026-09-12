import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { APPROVAL_DECISIONS, APPROVAL_STATUSES } from '../src/domain/types.ts';
import { APPROVALS_MODULE_SETTINGS } from '../src/settings.ts';

describe('approvals translations', () => {
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

	/* The list, the tag and the ledger each render a status or a decision by its
	   id, so one without copy shows the raw key. */
	it('names every status and every decision in both locales', () => {
		for (const status of APPROVAL_STATUSES) {
			expect([status, `status.${status}` in translationsEn]).toEqual([
				status,
				true,
			]);
			expect([status, `status.${status}` in translationsPl]).toEqual([
				status,
				true,
			]);
		}
		for (const decision of APPROVAL_DECISIONS) {
			expect([decision, `decision.${decision}` in translationsEn]).toEqual([
				decision,
				true,
			]);
			expect([decision, `decision.${decision}` in translationsPl]).toEqual([
				decision,
				true,
			]);
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(
			APPROVALS_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^approvals\./);
			expect(definition.descriptionKey).toMatch(/^approvals\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('approvals.'.length);
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
});
