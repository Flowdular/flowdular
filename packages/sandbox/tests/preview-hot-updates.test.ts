import { describe, expect, it, vi } from 'vitest';
import { octane } from '@octanejs/vite-plugin';
import type { Plugin } from 'vite';
import { isolatePreviewHotUpdates } from '../src/server/preview-hot-updates.ts';

async function update(file: string) {
	const send = vi.fn();
	const module = { id: file };
	const client = {
		getModulesByFile: vi.fn(() => new Set([module])),
		invalidateModule: vi.fn(),
	};
	const ssr = {
		getModulesByFile: vi.fn(() => new Set([module])),
		invalidateModule: vi.fn(),
	};
	const options = {
		file,
		modules: [],
		server: {
			environments: {
				client: { moduleGraph: client },
				ssr: { moduleGraph: ssr },
			},
		},
	};
	for (const plugin of isolatePreviewHotUpdates(
		octane() as Plugin[],
		'/workspace',
	)) {
		const hook = plugin.hotUpdate;
		if (hook)
			await (typeof hook === 'function' ? hook : hook.handler).call(
				{ environment: { name: 'client', hot: { send } } } as never,
				options as never,
			);
	}
	return { send, client, ssr };
}

describe('preview hot update isolation', () => {
	it.each(['.flowdular', '.coreloom'])(
		'invalidates %s draft caches without reloading the sandbox',
		async (directory) => {
			const result = await update(
				`/workspace/${directory}/sandbox/sessions/session/workspace/modules/blog/src/client/View.tsrx`,
			);
			expect(result.send).not.toHaveBeenCalled();
			expect(result.client.invalidateModule).toHaveBeenCalled();
			expect(result.ssr.invalidateModule).toHaveBeenCalled();
		},
	);
	it('keeps normal reloads for sandbox application code', async () => {
		const result = await update('/workspace/packages/sandbox/src/App.tsrx');
		expect(result.send).toHaveBeenCalledWith({ type: 'full-reload' });
	});
});
