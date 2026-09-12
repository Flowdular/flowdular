import { describe, expect, it } from 'vitest';
import type { SearchPage } from '../src/client/api.ts';
import {
	answerIsCurrent,
	applyPage,
	clearResults,
	createSearchClientState,
	providerLabels,
} from '../src/client/state.ts';

const PROVIDERS = [
	{
		key: 'users.members',
		moduleId: 'users.core',
		label: 'Members',
		permission: 'users.members.read',
	},
];

function hit(reference: string) {
	return {
		provider: 'users.members',
		ref: reference,
		title: reference,
		snippet: '',
		viewId: 'users',
		route: '/users?member=' + reference,
		score: 1,
	};
}

function page(
	references: readonly string[],
	nextCursor: string | null,
): SearchPage {
	return {
		hits: references.map(hit),
		nextCursor,
		providers: PROVIDERS,
		unavailable: [],
	};
}

describe('SEARCH-PAGING', () => {
	it('replaces the list and keeps the cursor a further page resumes from', () => {
		const client = createSearchClientState();

		applyPage(client, page(['ada'], 'cursor-1'), {
			term: 'ada',
			append: false,
		});

		expect(
			client.store.get(client.state.hits).map((entry) => entry.ref),
		).toEqual(['ada']);
		expect(client.store.get(client.state.nextCursor)).toBe('cursor-1');
		expect(client.store.get(client.state.searched)).toBe(true);
		expect(client.store.get(client.state.status)).toBe('idle');
	});

	it('extends the list with the page the cursor answered', () => {
		const client = createSearchClientState();
		applyPage(client, page(['ada'], 'cursor-1'), {
			term: 'ada',
			append: false,
		});

		applyPage(client, page(['alan'], null), { term: 'ada', append: true });

		expect(
			client.store.get(client.state.hits).map((entry) => entry.ref),
		).toEqual(['ada', 'alan']);
		expect(client.store.get(client.state.nextCursor)).toBeNull();
	});

	/* The first load asks with an empty query for the provider list only, so an
	   empty table must not read as "nothing matched". */
	it('does not count a query under the minimum as a search', () => {
		const client = createSearchClientState();

		applyPage(client, page([], null), { term: '', append: false });

		expect(client.store.get(client.state.searched)).toBe(false);
	});
});

describe('search screen state', () => {
	it('drops the hits and the page position when the term falls under the minimum', () => {
		const client = createSearchClientState();
		applyPage(
			client,
			{ ...page(['ada'], 'cursor-1'), unavailable: ['audit.trail'] },
			{ term: 'ada', append: false },
		);

		clearResults(client);

		expect(client.store.get(client.state.hits)).toEqual([]);
		expect(client.store.get(client.state.nextCursor)).toBeNull();
		expect(client.store.get(client.state.unavailable)).toEqual([]);
		expect(client.store.get(client.state.searched)).toBe(false);
		/* The provider list is the filter options, not a result: it survives. */
		expect(client.store.get(client.state.providers)).toEqual(PROVIDERS);
	});

	/* SEARCH-STALE-ANSWER. The screen dispatches, the member types on, the
	   answer comes back: writing it is decided exactly as the view decides it,
	   claim a ticket on dispatch and ask before writing. */
	function dispatch(client: ReturnType<typeof createSearchClientState>) {
		const requests = { current: 0 };
		return {
			requests,
			ticket: (requests.current += 1),
		};
	}

	it('SEARCH-STALE-ANSWER drops a search still in flight when the term falls under the minimum', () => {
		const client = createSearchClientState();
		client.store.set(client.state.query, 'ada', 'test/typed');
		const { requests, ticket } = dispatch(client);

		client.store.set(client.state.query, 'a', 'test/deleted');

		expect(answerIsCurrent(client, 'ada', ticket, requests)).toBe(false);
		expect(client.store.get(client.state.hits)).toEqual([]);
		expect(client.store.get(client.state.searched)).toBe(false);
	});

	it('SEARCH-STALE-ANSWER drops a search still in flight when the member typed a different term', () => {
		const client = createSearchClientState();
		client.store.set(client.state.query, 'ada', 'test/typed');
		const { requests, ticket } = dispatch(client);

		client.store.set(client.state.query, 'alan', 'test/typed-on');

		expect(answerIsCurrent(client, 'ada', ticket, requests)).toBe(false);
	});

	/* The screen asks once with no term at all to get the provider filter
	   options, and it asks before the member has typed anything. Retiring every
	   request on a term under the minimum would retire that one at mount and
	   leave the filter empty for good. */
	it('SEARCH-STALE-ANSWER keeps the provider load the screen asks for before the member types', () => {
		const client = createSearchClientState();
		const { requests, ticket } = dispatch(client);

		expect(answerIsCurrent(client, '', ticket, requests)).toBe(true);
	});

	it('SEARCH-STALE-ANSWER drops the answer an overlapping later request replaced', () => {
		const client = createSearchClientState();
		client.store.set(client.state.query, 'ada', 'test/typed');
		const { requests, ticket } = dispatch(client);

		requests.current += 1;

		expect(answerIsCurrent(client, 'ada', ticket, requests)).toBe(false);
	});

	it('SEARCH-STALE-ANSWER writes the answer to the term the box still holds', () => {
		const client = createSearchClientState();
		client.store.set(client.state.query, '  ada  ', 'test/typed');
		const { requests, ticket } = dispatch(client);

		expect(answerIsCurrent(client, 'ada', ticket, requests)).toBe(true);
	});

	it('labels a hit by its provider, or by the key when it is unknown', () => {
		const labels = providerLabels(PROVIDERS);
		expect(labels.get('users.members')).toBe('Members');
		expect(labels.get('audit.trail')).toBeUndefined();
	});
});
