import { describe, expect, it } from 'vitest';
import type { ModuleSettingChange } from '@flowdular/kernel';
import { memorySettings } from '../src/server/preview-runtime.ts';

function previewSettings() {
	const settings = memorySettings();
	settings.declare({
		moduleId: 'system.core',
		settings: {
			timeZone: {
				type: 'string',
				defaultValue: 'UTC',
				visibility: 'shared',
				client: true,
				scope: 'tenant',
			},
			brandName: {
				type: 'string',
				defaultValue: 'Flowdular',
				visibility: 'shared',
				client: true,
				scope: 'platform',
			},
		},
	});
	return settings;
}

describe('preview settings change log', () => {
	it('answers the newest change of each setting in revision order', async () => {
		const settings = previewSettings();
		const heard: ModuleSettingChange[] = [];
		settings.onChange((change) => heard.push(change));

		await settings.set(
			'tenant-a',
			'system.core',
			'timeZone',
			'Europe/Warsaw',
			'a',
		);
		await settings.set(
			'tenant-b',
			'system.core',
			'timeZone',
			'Asia/Tokyo',
			'b',
		);
		await settings.set('tenant-a', 'system.core', 'brandName', 'Acme', 'a');
		await settings.set('tenant-a', 'system.core', 'timeZone', null, 'a');

		expect(heard.map((change) => change.revision)).toEqual([1, 2, 3, 4]);
		const all = await settings.changesAfter({ after: null, limit: 500 });
		expect(all).toMatchObject({
			expired: false,
			more: false,
			changes: [
				{ revision: 2, tenantId: 'tenant-b', key: 'timeZone', cleared: false },
				{ revision: 3, tenantId: '', key: 'brandName', cleared: false },
				{ revision: 4, tenantId: 'tenant-a', key: 'timeZone', cleared: true },
			],
		});

		const first = await settings.changesAfter({
			after: null,
			limit: 1,
			moduleId: 'system.core',
			key: 'timeZone',
		});
		if (first.expired) throw new Error('A preview cursor expired.');
		expect(first.changes.map((change) => change.revision)).toEqual([2]);
		expect(first.more).toBe(true);
		const rest = await settings.changesAfter({
			after: first.cursor,
			limit: 1,
			moduleId: 'system.core',
			key: 'timeZone',
		});
		expect(rest).toMatchObject({
			more: false,
			changes: [{ revision: 4 }],
		});
	});

	it('refuses a cursor the preview never answered', async () => {
		await expect(
			previewSettings().changesAfter({ after: 'not-a-cursor', limit: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_SETTINGS_CURSOR' });
	});
});
