import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	activeLocale,
	cancelActiveLocalePreview,
	previewActiveLocale,
	restoreAccountLocaleCache,
	setServerAccountLocale,
	setTenantDefaultLocale,
} from '../src/i18n/runtime.ts';

describe('server-backed account locale', () => {
	const values = new Map<string, string>();

	beforeEach(() => {
		values.clear();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		});
		setTenantDefaultLocale('en');
	});

	afterEach(() => vi.unstubAllGlobals());

	it('uses a scoped cache only until the server returns a preference', () => {
		const key = 'flowdular.locale.account.account-a.tenant-a';
		values.set(key, 'pl');

		restoreAccountLocaleCache('account-a', 'tenant-a');
		expect(activeLocale()).toBe('pl');

		setServerAccountLocale('en');
		expect(activeLocale()).toBe('en');
		expect(values.get(key)).toBe('en');
	});

	it('removes a stale cache when the server reports no personal choice', () => {
		const key = 'flowdular.locale.account.account-a.tenant-a';
		values.set(key, 'pl');
		restoreAccountLocaleCache('account-a', 'tenant-a');

		setServerAccountLocale(null);

		expect(activeLocale()).toBe('en');
		expect(values.has(key)).toBe(false);
	});

	it('previews a selection and can revert it to the last server value', () => {
		restoreAccountLocaleCache('account-a', 'tenant-a');
		setServerAccountLocale('en');

		previewActiveLocale('pl');
		expect(activeLocale()).toBe('pl');
		cancelActiveLocalePreview();
		expect(activeLocale()).toBe('en');
	});
});
