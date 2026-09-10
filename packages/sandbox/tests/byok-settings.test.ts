import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { byokSettings } from '../src/server/byok-settings.ts';
import {
	openSecret,
	safeConfiguration,
	DEFAULT_CONFIGURATION,
} from '../src/server/config.ts';

describe('BYOK settings', () => {
	it('seals keys, preserves them only for the same destination and supports removal', async () => {
		const root = await mkdtemp(join(tmpdir(), 'byok-settings-'));
		const input = {
			byokKind: 'openai-compatible',
			byokModel: 'custom-model',
			byokBaseUrl: 'https://models.example/v1',
			byokCredential: 'test-key',
		};
		const saved = (await byokSettings(root, input, null))!;
		expect(await openSecret(root, saved.credential!)).toBe('test-key');
		expect(
			JSON.stringify(
				safeConfiguration({ ...DEFAULT_CONFIGURATION, byok: saved }),
			),
		).not.toContain('test-key');
		expect(
			(
				await byokSettings(
					root,
					{ ...input, byokCredential: '', byokModel: 'other-model' },
					saved,
				)
			)?.credential,
		).toEqual(saved.credential);
		expect(
			(
				await byokSettings(
					root,
					{
						...input,
						byokCredential: '',
						byokBaseUrl: 'https://other.example/v1',
					},
					saved,
				)
			)?.credential,
		).toBeNull();
		expect(
			(
				await byokSettings(
					root,
					{ ...input, byokCredential: '', byokClearCredential: true },
					saved,
				)
			)?.credential,
		).toBeNull();
		expect(await byokSettings(root, { byokRemove: true }, saved)).toBeNull();
		expect(await byokSettings(root, {}, saved)).toBeUndefined();
	});
	it.each([
		{
			byokKind: 'openai-compatible',
			byokModel: 'model',
			byokBaseUrl: 'http://remote.example/v1',
		},
		{ byokKind: 'unknown', byokModel: 'model' },
		{ byokKind: 'openai', byokModel: '' },
		{ byokKind: 'azure', byokModel: 'deployment' },
		{ byokKind: 'openai-compatible', byokModel: 'model' },
		{
			byokKind: 'openai-compatible',
			byokModel: 'model',
			byokBaseUrl: 'https://user:secret@example.com',
		},
	])('rejects invalid settings before persistence: %j', async (input) => {
		await expect(byokSettings('/unused', input, null)).rejects.toThrow();
	});
});
