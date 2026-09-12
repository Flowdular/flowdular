import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	DIRECTORY_REASONS,
	PROVISIONING_OPERATIONS,
	PROVISIONING_OUTCOMES,
	SCIM_TOKEN_STATUSES,
} from '../src/domain/types.ts';
import { DIRECTORY_MODULE_SETTINGS } from '../src/settings.ts';

describe('directory translations', () => {
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

	it('names every operation, outcome and token status in both locales', () => {
		const bundles: Record<string, string>[] = [translationsEn, translationsPl];
		for (const bundle of bundles) {
			for (const operation of PROVISIONING_OPERATIONS) {
				expect([operation, `log.operation.${operation}` in bundle]).toEqual([
					operation,
					true,
				]);
			}
			for (const outcome of PROVISIONING_OUTCOMES) {
				expect([outcome, `log.outcome.${outcome}` in bundle]).toEqual([
					outcome,
					true,
				]);
			}
			for (const status of SCIM_TOKEN_STATUSES) {
				expect([status, `tokens.status.${status}` in bundle]).toEqual([
					status,
					true,
				]);
			}
		}
	});

	/* A refusal reaches the provisioning log as a stable code, so every code the
	   server can emit needs a sentence a reader can act on. */
	it('explains every stable reason code in both locales', () => {
		const bundles: Record<string, string>[] = [translationsEn, translationsPl];
		for (const bundle of bundles) {
			for (const reason of Object.values(DIRECTORY_REASONS)) {
				expect([reason, `reason.${reason}` in bundle]).toEqual([reason, true]);
			}
		}
	});

	it('translates every declared module setting label and description', () => {
		const bundles: Record<string, string>[] = [translationsEn, translationsPl];
		for (const definition of Object.values(
			DIRECTORY_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^directory\./);
			expect(definition.descriptionKey).toMatch(/^directory\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('directory.'.length);
				for (const bundle of bundles) {
					expect([localKey, localKey in bundle]).toEqual([localKey, true]);
				}
			}
		}
	});
});
