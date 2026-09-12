import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import type { SettingsEntryPayload } from '../src/client/settings-api.ts';
import {
	createFlagsState,
	createSectionState,
	rowKey,
	saveFlag,
	saveSetting,
} from '../src/client/settings-state.ts';

function entry(key: string, value = false): SettingsEntryPayload {
	return {
		key,
		type: 'boolean',
		scope: 'tenant',
		label: key,
		description: '',
		value,
		hasValue: value,
		defaultValue: false,
		secret: false,
	};
}

const realFetch = globalThis.fetch;

/**
 * Every save left hanging until the case answers it, so two of them are in
 * flight at once. The queue is in call order, and answering out of order is
 * what a slow first row does to a fast second one.
 */
function deferredSaves(): ((setting: SettingsEntryPayload) => void)[] {
	const answers: ((setting: SettingsEntryPayload) => void)[] = [];
	globalThis.fetch = (() =>
		new Promise<Response>((resolve) => {
			answers.push((setting) => {
				resolve(
					new Response(JSON.stringify({ setting }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			});
		})) as typeof fetch;
	return answers;
}

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'system.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(() => {
	setActiveLocale('en');
});

describe('settings rows saved in parallel', () => {
	it('keeps both rows when a module setting save overlaps another', async () => {
		const client = createSectionState();
		client.store.set(client.state.settings, [entry('alpha'), entry('beta')]);
		const answers = deferredSaves();

		const alpha = saveSetting(client, 'demo.core', 'alpha', true, 'csrf');
		const beta = saveSetting(client, 'demo.core', 'beta', true, 'csrf');
		expect(answers).toHaveLength(2);
		/* The second row answers first, so the first one writes back last. */
		answers[1]!(entry('beta', true));
		answers[0]!(entry('alpha', true));
		await Promise.all([alpha, beta]);

		expect(
			client.store
				.get(client.state.settings)
				.map((setting) => [setting.key, setting.value]),
		).toEqual([
			['alpha', true],
			['beta', true],
		]);
		const results = client.store.get(client.state.results);
		expect([...results.keys()].sort()).toEqual(['alpha', 'beta']);
		expect([...results.values()].map((result) => result.ok)).toEqual([
			true,
			true,
		]);
		expect(client.store.get(client.state.busyKey)).toBe(null);
	});

	it('keeps both flags and the busy row when two flag saves overlap', async () => {
		const client = createFlagsState();
		client.store.set(client.state.groups, [
			{
				moduleId: 'documents.core',
				name: 'Documents Core',
				flags: [entry('bulkUpload'), entry('inlinePreview')],
			},
		]);
		const answers = deferredSaves();

		const bulk = saveFlag(client, 'documents.core', 'bulkUpload', true, 'csrf');
		const inline = saveFlag(
			client,
			'documents.core',
			'inlinePreview',
			true,
			'csrf',
		);
		answers[0]!(entry('bulkUpload', true));
		await bulk;
		/* The second row is still saving, so the indicator stays on it. */
		expect(client.store.get(client.state.busyKey)).toBe(
			rowKey('documents.core', 'inlinePreview'),
		);
		answers[1]!(entry('inlinePreview', true));
		await inline;

		expect(
			client.store
				.get(client.state.groups)[0]!
				.flags.map((flag) => [flag.key, flag.value]),
		).toEqual([
			['bulkUpload', true],
			['inlinePreview', true],
		]);
		const results = client.store.get(client.state.results);
		expect([...results.keys()]).toEqual([
			rowKey('documents.core', 'bulkUpload'),
			rowKey('documents.core', 'inlinePreview'),
		]);
		expect(client.store.get(client.state.busyKey)).toBe(null);
	});

	it('reports a failed save on its own row and leaves the others alone', async () => {
		const client = createSectionState();
		client.store.set(client.state.settings, [entry('alpha'), entry('beta')]);
		const answers: (() => void)[] = [];
		globalThis.fetch = ((input: unknown, init?: RequestInit) =>
			new Promise<Response>((resolve) => {
				const body = String(init?.body ?? '');
				answers.push(() => {
					resolve(
						body.includes('beta')
							? new Response(
									JSON.stringify({ error: { message: 'Denied by policy.' } }),
									{ status: 403 },
								)
							: new Response(
									JSON.stringify({ setting: entry('alpha', true) }),
									{
										status: 200,
									},
								),
					);
				});
			})) as typeof fetch;

		const alpha = saveSetting(client, 'demo.core', 'alpha', true, 'csrf');
		const beta = saveSetting(client, 'demo.core', 'beta', true, 'csrf');
		answers[1]!();
		answers[0]!();
		await Promise.all([alpha, beta]);

		const results = client.store.get(client.state.results);
		expect(results.get('alpha')?.ok).toBe(true);
		expect(results.get('beta')).toEqual({
			ok: false,
			message: 'Denied by policy.',
		});
		expect(
			client.store
				.get(client.state.settings)
				.map((setting) => [setting.key, setting.value]),
		).toEqual([
			['alpha', true],
			['beta', false],
		]);
		expect(client.store.get(client.state.busyKey)).toBe(null);
	});
});
