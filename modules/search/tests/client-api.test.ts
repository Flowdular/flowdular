import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberQuery, searchRecords } from '../src/client/api.ts';
import { searchCommandContribution } from '../src/client/navigation.ts';

function answer(): () => Promise<Response> {
	return async () =>
		Response.json({
			items: [],
			page: { nextCursor: null },
			providers: [],
			unavailable: [],
		});
}

function pathOf(mock: ReturnType<typeof vi.fn>, call = 0): string {
	return (mock.mock.calls[call] as [string, RequestInit])[0];
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('SEARCH-RECENT-DELIBERATE on the wire', () => {
	/* Recall is asked for by the request. Everything that searches while the
	   member is still typing leaves the flag off, so a prefix is never kept. */
	it('asks to remember only when the caller said so', async () => {
		const fetchMock = vi.fn(answer());
		vi.stubGlobal('fetch', fetchMock);

		await searchRecords({ query: 'ada' });
		await searchRecords({ query: 'ada', remember: true });

		expect(pathOf(fetchMock)).toBe('/api/search?q=ada');
		expect(pathOf(fetchMock, 1)).toBe('/api/search?q=ada&remember=1');
	});

	/* The palette searches on every debounced keystroke. */
	it('never asks the palette search to be remembered', async () => {
		const fetchMock = vi.fn(answer());
		vi.stubGlobal('fetch', fetchMock);

		await searchCommandContribution.search({
			query: 'ada',
			signal: new AbortController().signal,
		});

		expect(pathOf(fetchMock)).not.toContain('remember');
	});

	/* SEARCH-OPEN-RECALL. The browser is leaving the view as this is sent, so
	   the request has to outlive it and must not be a whole search. */
	it('SEARCH-OPEN-RECALL keeps an opened query through one write that survives the unload', async () => {
		const fetchMock = vi.fn(async (_path: string, _init: RequestInit) =>
			Response.json({ recorded: true }),
		);
		vi.stubGlobal('fetch', fetchMock);

		expect(await rememberQuery('ada', 'csrf-1')).toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [path, init] = fetchMock.mock.calls[0]!;
		expect(path).toBe('/api/search/recent');
		expect(init.method).toBe('POST');
		expect(init.keepalive).toBe(true);
		expect(init.body).toBe(JSON.stringify({ q: 'ada' }));
		expect((init.headers as Record<string, string>)['x-csrf-token']).toBe(
			'csrf-1',
		);
	});

	it('sends the cursor back for the page after the first', async () => {
		const fetchMock = vi.fn(answer());
		vi.stubGlobal('fetch', fetchMock);

		await searchRecords({ query: 'ada', cursor: 'page-2', limit: 25 });

		expect(pathOf(fetchMock)).toBe('/api/search?q=ada&cursor=page-2&limit=25');
	});
});
