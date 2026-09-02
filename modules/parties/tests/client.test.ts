import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPartyHistory } from '../src/client/api.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

afterEach(() => {
	vi.unstubAllGlobals();
	setActiveLocale('en');
});

describe('parties client contract', () => {
	it('keeps history and lifecycle translation families complete in Polish', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		registerModuleTranslations([
			{
				moduleId: 'parties.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const namespace of ['customer', 'supplier']) {
				for (const suffix of [
					'title',
					'description',
					'new',
					'tableTitle',
					'emptyTitle',
					'emptyHint',
					'drawerSubtitle',
				]) {
					const key = `parties.${namespace}.${suffix}`;
					expect(t(key), `${locale}: ${key}`).not.toBe(key);
				}
			}
			for (const kind of ['customer', 'supplier', 'both']) {
				const key = 'parties.kind.' + kind;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const status of ['active', 'archived']) {
				const key = 'parties.status.' + status;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const action of [
				'created',
				'updated',
				'archived',
				'restored',
				'deleted',
			]) {
				const key = 'parties.history.action.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const actor of ['user', 'agent']) {
				const key = 'parties.history.actor.' + actor;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			const serviceKey = 'parties.history.actor.serviceConfiguredBy';
			expect(
				t(serviceKey, { name: 'Ada' }),
				`${locale}: ${serviceKey}`,
			).not.toBe(serviceKey);
			for (const field of [
				'name',
				'kind',
				'email',
				'phone',
				'vatId',
				'status',
			]) {
				const key = 'parties.history.field.' + field;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('loads the selected record history through the tenant-scoped API', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						entries: [],
						nextCursor: null,
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' },
					},
				),
		);
		vi.stubGlobal('fetch', fetch);

		await expect(loadPartyHistory('party / one')).resolves.toEqual({
			entries: [],
			nextCursor: null,
		});
		expect(fetch).toHaveBeenCalledWith(
			'/api/parties/history?recordId=party%20%2F%20one&limit=100',
			{
				headers: { accept: 'application/json' },
				credentials: 'same-origin',
			},
		);
	});
});
