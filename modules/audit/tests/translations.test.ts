import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	AUDIT_REASONS,
	EXPORT_STATUSES,
	HOLD_SCOPE_KINDS,
	HOLD_STATUSES,
	RETENTION_MODES,
	SWEEP_STATUSES,
} from '../src/domain/types.ts';
import { AUDIT_MODULE_SETTINGS } from '../src/settings.ts';

describe('audit translations', () => {
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

	it('names every status, retention mode and ledger reason in both locales', () => {
		const keys = [
			...SWEEP_STATUSES.map((status) => `sweeps.status.${status}`),
			...EXPORT_STATUSES.map((status) => `exports.status.${status}`),
			...RETENTION_MODES.map((mode) => `retention.mode.${mode}`),
			...Object.values(AUDIT_REASONS).map((reason) => `reason.${reason}`),
			...HOLD_STATUSES.map((status) => `holds.status.${status}`),
			...HOLD_SCOPE_KINDS.map((scope) => `holds.scope.${scope}`),
		];
		for (const key of keys) {
			expect([key, key in translationsEn]).toEqual([key, true]);
			expect([key, key in translationsPl]).toEqual([key, true]);
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(AUDIT_MODULE_SETTINGS.settings)) {
			expect(definition.labelKey).toMatch(/^audit\./);
			expect(definition.descriptionKey).toMatch(/^audit\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('audit.'.length);
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
