import { describe, expect, it } from 'vitest';
import {
	DownloadBlocked,
	runDownload,
	type DownloadTab,
	type DownloadWindow,
} from '../src/client/download.ts';

function fakeWindow(blocked = false): {
	readonly view: DownloadWindow;
	readonly tabs: (DownloadTab & { closed: boolean })[];
} {
	const tabs: (DownloadTab & { closed: boolean })[] = [];
	const view: DownloadWindow = {
		open() {
			if (blocked) return null;
			const tab = {
				location: { href: '' },
				opener: {} as unknown,
				closed: false,
				close() {
					this.closed = true;
				},
			};
			tabs.push(tab);
			return tab;
		},
	};
	return { view, tabs };
}

describe('starting a download from a click', () => {
	/* The tab has to be claimed inside the click. One opened after the read URL
	   resolves is a pop-up, and the browser drops it. */
	it('opens the tab before the URL is resolved', async () => {
		const { view, tabs } = fakeWindow();
		let openTabsWhenResolving = -1;

		await runDownload(view, async () => {
			openTabsWhenResolving = tabs.length;
			return 'https://erp.example/api/storage/objects/token';
		});

		expect(openTabsWhenResolving).toBe(1);
		expect(tabs[0]?.location.href).toBe(
			'https://erp.example/api/storage/objects/token',
		);
		/* The download route must not reach back into the application. */
		expect(tabs[0]?.opener).toBeNull();
		expect(tabs[0]?.closed).toBe(false);
	});

	it('closes the tab and reports the failure when no URL is issued', async () => {
		const { view, tabs } = fakeWindow();
		const refusal = new Error('DOCUMENT_INFECTED');

		await expect(runDownload(view, () => Promise.reject(refusal))).rejects.toBe(
			refusal,
		);
		expect(tabs[0]?.closed).toBe(true);
		expect(tabs[0]?.location.href).toBe('');
	});

	/* A blocked pop-up is silent otherwise: the reader clicks and nothing at
	   all happens. */
	it('reports a tab the browser refused to open', async () => {
		const { view } = fakeWindow(true);
		let resolved = false;

		await expect(
			runDownload(view, async () => {
				resolved = true;
				return 'https://erp.example/api/storage/objects/token';
			}),
		).rejects.toBeInstanceOf(DownloadBlocked);
		expect(resolved).toBe(false);
	});
});
