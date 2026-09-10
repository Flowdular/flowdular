import { afterEach, expect, it, vi } from 'vitest';
import { loadWebPage, webPageData } from '../src/web.ts';

afterEach(() => vi.unstubAllGlobals());

it('uses the same explicit DTO during SSR and browser hydration without a second fetch', () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	const data = { title: 'Published', nullable: null };
	expect(
		webPageData({
			url: '/site',
			state: new Map([['flowdular.web.data', data]]),
		}),
	).toEqual(data);
	vi.stubGlobal('document', {
		getElementById: () => ({
			textContent: JSON.stringify({ url: '/site', data }),
		}),
	});
	expect(webPageData({ url: '/site' })).toEqual(data);
	expect(() => webPageData({ url: '/other' })).toThrow(/unavailable/);
	expect(fetch).not.toHaveBeenCalled();
});

it('fetches refresh data through the same page URL and propagates denials and cancellation', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ title: 'Refreshed' }))
		.mockResolvedValueOnce(new Response(null, { status: 403 }));
	vi.stubGlobal('fetch', fetch);
	const signal = new AbortController().signal;
	expect(await loadWebPage('/site?filter=recent', signal)).toEqual({
		title: 'Refreshed',
	});
	expect(fetch).toHaveBeenCalledWith(
		'/site?filter=recent',
		expect.objectContaining({
			signal,
			cache: 'no-store',
			headers: { accept: 'application/vnd.flowdular.page+json' },
		}),
	);
	await expect(loadWebPage('/private')).rejects.toThrow('403');
});
