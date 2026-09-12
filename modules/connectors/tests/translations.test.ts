import { describe, expect, it } from 'vitest';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_CALL_OUTCOMES,
	CONNECTOR_CALLERS,
	CONNECTOR_INSTANCE_STATUSES,
} from '../src/domain/types.ts';
import { CONNECTORS_MODULE_SETTINGS } from '../src/settings.ts';

const BUNDLES = [
	['en', translationsEn],
	['pl', translationsPl],
] as const;

describe('connectors translations', () => {
	it('ships matching English and Polish keys', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('leaves no empty value in either locale', () => {
		for (const [, bundle] of BUNDLES) {
			for (const [key, value] of Object.entries(bundle)) {
				expect([key, typeof value === 'string' && value.length > 0]).toEqual([
					key,
					true,
				]);
			}
		}
	});

	it('names every enumerated value the screens render in both locales', () => {
		const keys = [
			...CONNECTOR_INSTANCE_STATUSES.map((value) => `status.${value}`),
			...CONNECTOR_CALL_OUTCOMES.map((value) => `outcome.${value}`),
			...CONNECTOR_CALLERS.map((value) => `caller.${value}`),
			...CONNECTOR_AUTH_KINDS.map((value) => `authKind.${value}`),
		];
		for (const [locale, bundle] of BUNDLES) {
			for (const key of keys) {
				expect([locale, key, key in bundle]).toEqual([locale, key, true]);
			}
		}
	});

	it('translates every declared module setting label and description', () => {
		for (const definition of Object.values(
			CONNECTORS_MODULE_SETTINGS.settings,
		)) {
			expect(definition.labelKey).toMatch(/^connectors\./);
			expect(definition.descriptionKey).toMatch(/^connectors\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('connectors.'.length);
				for (const [locale, bundle] of BUNDLES) {
					expect([locale, localKey, localKey in bundle]).toEqual([
						locale,
						localKey,
						true,
					]);
				}
			}
		}
	});

	/* A refusal the screens can raise must read as a sentence, not as the code
	   the server uses. */
	it('translates every stable error code a screen can show', () => {
		for (const code of [
			'INSTANCE_NAME_TAKEN',
			'INSTANCE_NOT_FOUND',
			'INSTANCE_ACTIVE',
			'DEFINITION_UNKNOWN',
			'AUTH_KIND_UNSUPPORTED',
			'CREDENTIAL_INVALID',
			'HOST_NOT_ALLOWLISTED',
			'EGRESS_REFUSED',
			'CONSENT_NOT_CONFIRMED',
			'FORBIDDEN',
			'CSRF_REJECTED',
		]) {
			for (const [locale, bundle] of BUNDLES) {
				const key = `error.code.${code}`;
				expect([locale, key, key in bundle]).toEqual([locale, key, true]);
			}
		}
	});
});
