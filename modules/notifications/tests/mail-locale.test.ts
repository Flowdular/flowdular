import { describe, expect, it } from 'vitest';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';
import {
	DEFAULT_MAIL_LOCALE,
	TENANT_LOCALE_KEY,
	TENANT_LOCALE_MODULE_ID,
	tenantMailLocale,
} from '../src/domain/locale.ts';

/** Only the read the resolver makes; every other member fails the test loudly. */
function settings(
	read: (tenantId: string, moduleId: string, key: string) => string,
): ModuleSettingsRuntime {
	return {
		get: read,
		declare: () => {
			throw new Error('unexpected declare');
		},
		declarations: () => {
			throw new Error('unexpected declarations');
		},
		list: () => {
			throw new Error('unexpected list');
		},
		set: () => {
			throw new Error('unexpected set');
		},
		onChange: () => {
			throw new Error('unexpected onChange');
		},
	} as unknown as ModuleSettingsRuntime;
}

describe('workspace mail locale', () => {
	it('carries the workspace default locale of the addressed tenant', () => {
		const runtime = settings((tenantId, moduleId, key) => {
			expect([moduleId, key]).toEqual([
				TENANT_LOCALE_MODULE_ID,
				TENANT_LOCALE_KEY,
			]);
			return tenantId === 'tenant-pl' ? 'pl' : 'en-GB';
		});

		expect(tenantMailLocale(runtime, 'tenant-pl')).toBe('pl');
		expect(tenantMailLocale(runtime, 'tenant-gb')).toBe('en-GB');
	});

	/* A deployment without auth.core, and a stored value the mail port would
	   refuse, must not make every message of that workspace undeliverable. */
	it('falls back to English when the setting is unreadable or unusable', () => {
		const absent = settings(() => {
			throw new Error('auth.core declared no settings');
		});
		expect(tenantMailLocale(absent, 'tenant-a')).toBe(DEFAULT_MAIL_LOCALE);

		for (const stored of [
			'',
			'  ',
			'not a tag',
			'e',
			'en_GB',
			/* Shaped like a tag, past the length one header value may carry. */
			'en-abcdefgh-ijklm',
		]) {
			expect([
				stored,
				tenantMailLocale(
					settings(() => stored),
					'tenant-a',
				),
			]).toEqual([stored, DEFAULT_MAIL_LOCALE]);
		}
	});
});
