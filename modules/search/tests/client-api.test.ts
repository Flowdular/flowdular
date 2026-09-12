import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberQuery, searchRecords } from '../src/client/api.ts';
import { createSearchCommandContribution } from '../src/client/navigation.ts';

function answer(): () => Promise<Response> {
	return async () =>
		Response.json({
			items: [],
			page: { nextCursor: null },
			providers: [],
			unavailable: [],
		});
}

/** A page whose one hit is named after the term that found it. */
function foundPage(path: string): Response {
	const reference =
		new URLSearchParams(path.slice(path.indexOf('?'))).get('q') ?? '';
	return Response.json({
		items: [
			{
				provider: 'users.members',
				ref: reference,
				title: reference,
				snippet: 'about ' + reference,
				viewId: 'users',
				route: '/users?member=' + reference,
				score: 1,
			},
		],
		page: { nextCursor: null },
		providers: [{ key: 'users.members', label: 'Members' }],
		unavailable: [],
	});
}

function paletteAnswers(): (
	path: string,
	init: RequestInit,
) => Promise<Response> {
	return async (path) =>
		path.startsWith('/api/search?')
			? foundPage(path)
			: Response.json({ recorded: true });
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

		await createSearchCommandContribution('csrf-1').search({
			query: 'ada',
			signal: new AbortController().signal,
		});

		expect(pathOf(fetchMock)).not.toContain('remember');
	});

	/* SEARCH-OPEN-RECALL from the palette. Opening a hit there is the same
	   deliberate submit as opening one on the screen, so it is kept by the same
	   write, and by no second search. */
	it('SEARCH-OPEN-RECALL keeps the query of a hit opened from the palette', async () => {
		const fetchMock = vi.fn(paletteAnswers());
		vi.stubGlobal('fetch', fetchMock);
		const contribution = createSearchCommandContribution('csrf-1');

		const hits = await contribution.search({
			query: 'ada',
			signal: new AbortController().signal,
		});
		await contribution.onOpen?.(hits[0]!);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [path, init] = fetchMock.mock.calls[1]!;
		expect(path).toBe('/api/search/recent');
		expect(init.method).toBe('POST');
		expect(init.keepalive).toBe(true);
		expect(init.body).toBe(JSON.stringify({ q: 'ada' }));
		expect((init.headers as Record<string, string>)['x-csrf-token']).toBe(
			'csrf-1',
		);
	});

	/* Recall has to name the query that found the record. The palette answers
	   again on every keystroke, so the term the box holds when a hit is opened is
	   not always the term that hit came back under. */
	it('keeps the query the opened hit answered, not the one typed since', async () => {
		const fetchMock = vi.fn(paletteAnswers());
		vi.stubGlobal('fetch', fetchMock);
		const contribution = createSearchCommandContribution('csrf-1');
		const signal = new AbortController().signal;

		const first = await contribution.search({ query: 'ada', signal });
		const second = await contribution.search({ query: 'alan', signal });
		await contribution.onOpen?.(second[0]!);
		/* The palette lists one answer at a time, so a hit of the answer it
		   replaced is not on offer any more and keeps nothing. */
		await contribution.onOpen?.(first[0]!);

		const writes = fetchMock.mock.calls.filter(
			(call) => call[0] === '/api/search/recent',
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]![1].body).toBe(JSON.stringify({ q: 'alan' }));
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
