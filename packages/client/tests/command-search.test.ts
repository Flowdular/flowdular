import { describe, expect, it } from 'vitest';
import { createClientContributionRegistry } from '../src/contributions.ts';
import type {
	CommandSearchContribution,
	CommandSearchHit,
} from '../src/contributions.ts';
import {
	commandSearchHitOpened,
	commandSearchOutcome,
	commandSearchReady,
	groupCommandSearchHits,
	runCommandSearch,
	COMMAND_SEARCH_GROUP_LIMIT,
	COMMAND_SEARCH_MINIMUM,
} from '../src/shell/command-search.ts';
import {
	onOpenCommandPalette,
	openCommandPalette,
} from '../src/shell/command.ts';

function hit(provider: string, reference: string): CommandSearchHit {
	return {
		id: provider + ':' + reference,
		provider,
		providerLabel: provider === 'users.members' ? 'Members' : provider,
		title: reference,
		snippet: 'about ' + reference,
		viewId: 'users',
		route: '/users?member=' + reference,
	};
}

function contribution(
	id: string,
	answer: () => Promise<readonly CommandSearchHit[]>,
	order = 10,
): CommandSearchContribution {
	return { id, scope: 'search.records.read', order, search: answer };
}

describe('command search readiness', () => {
	it('asks nobody below the minimum and asks at it', () => {
		expect(commandSearchReady('a')).toBe(false);
		expect(commandSearchReady('  a  ')).toBe(false);
		expect(commandSearchReady('a'.repeat(COMMAND_SEARCH_MINIMUM))).toBe(true);
	});

	it('ignores surrounding whitespace when deciding', () => {
		expect(commandSearchReady('   ')).toBe(false);
		expect(commandSearchReady('  ad  ')).toBe(true);
	});
});

describe('grouping command search hits', () => {
	it('groups by provider in the order the hits arrived', () => {
		const groups = groupCommandSearchHits([
			hit('users.members', 'ada'),
			hit('documents.files', 'report'),
			hit('users.members', 'alan'),
		]);

		expect(groups.map((group) => group.provider)).toEqual([
			'users.members',
			'documents.files',
		]);
		expect(groups[0]?.hits.map((entry) => entry.title)).toEqual([
			'ada',
			'alan',
		]);
		expect(groups[0]?.label).toBe('Members');
	});

	/* A talkative provider must not push every other group off the palette. */
	it('caps each group', () => {
		const many = Array.from(
			{ length: COMMAND_SEARCH_GROUP_LIMIT + 4 },
			(_, index) => hit('users.members', 'member-' + index),
		);

		const groups = groupCommandSearchHits([...many, hit('audit.classes', 'x')]);

		expect(groups[0]?.hits).toHaveLength(COMMAND_SEARCH_GROUP_LIMIT);
		expect(groups[1]?.hits).toHaveLength(1);
	});

	it('answers nothing for no hits', () => {
		expect(groupCommandSearchHits([])).toEqual([]);
	});
});

describe('running contributed searches', () => {
	it('keeps the contributions in the order they were given', async () => {
		const found = await runCommandSearch(
			[
				contribution('a', async () => [hit('users.members', 'ada')]),
				contribution('b', async () => [hit('documents.files', 'report')]),
			],
			'ad',
			new AbortController().signal,
		);

		expect(found.hits.map((entry) => entry.id)).toEqual([
			'users.members:ada',
			'documents.files:report',
		]);
		expect(found.failed).toEqual([]);
	});

	/* A contribution is foreign code on the shell path: the palette has to keep
	   working whatever a module does. */
	it('keeps the other answers when one contribution rejects', async () => {
		const found = await runCommandSearch(
			[
				contribution('broken', async () => {
					throw new Error('module is down');
				}),
				contribution('good', async () => [hit('users.members', 'ada')]),
			],
			'ad',
			new AbortController().signal,
		);

		expect(found.hits.map((entry) => entry.id)).toEqual(['users.members:ada']);
	});

	/* The member is shown one group out of two. Without the failure travelling
	   back with the hits the palette reads as a complete answer and says the
	   other module simply has nothing. */
	it('names the contribution that rejected', async () => {
		const found = await runCommandSearch(
			[
				contribution('broken', async () => {
					throw new Error('module is down');
				}),
				contribution('good', async () => [hit('users.members', 'ada')]),
			],
			'ad',
			new AbortController().signal,
		);

		expect(found.failed).toEqual(['broken']);
	});

	it('names a contribution that throws before it returns a promise', async () => {
		const found = await runCommandSearch(
			[
				{
					id: 'sync-throw',
					scope: 'search.records.read',
					order: 1,
					search: () => {
						throw new Error('module is down');
					},
				},
				contribution('good', async () => [hit('users.members', 'ada')]),
			],
			'ad',
			new AbortController().signal,
		);

		expect(found.failed).toEqual(['sync-throw']);
		expect(found.hits.map((entry) => entry.id)).toEqual(['users.members:ada']);
	});

	it('drops an answer that is not a list of readable hits', async () => {
		const found = await runCommandSearch(
			[
				contribution('odd', async () => 'nope' as never),
				contribution('partial', async () => [
					{ provider: 'x' } as never,
					hit('users.members', 'ada'),
				]),
			],
			'ad',
			new AbortController().signal,
		);

		expect(found.hits.map((entry) => entry.id)).toEqual(['users.members:ada']);
		/* A list the shell could read entries out of answered; only the one that
		   was not a list at all contributed nothing. */
		expect(found.failed).toEqual(['odd']);
	});

	it('counts an empty answer as an answer', async () => {
		const found = await runCommandSearch(
			[contribution('quiet', async () => [])],
			'ad',
			new AbortController().signal,
		);

		expect(found).toEqual({ hits: [], failed: [] });
	});

	it('hands every contribution the same abort signal', async () => {
		const controller = new AbortController();
		const seen: AbortSignal[] = [];
		await runCommandSearch(
			[
				contribution('a', async () => []),
				contribution('b', async () => []),
			].map((entry) => ({
				...entry,
				search: async (request) => {
					seen.push(request.signal);
					return [];
				},
			})),
			'ad',
			controller.signal,
		);

		expect(seen).toEqual([controller.signal, controller.signal]);
	});
});

describe('opening a record hit', () => {
	type RejectionListener = (reason: unknown) => void;
	/* What escaped the shell, read from the test host. The package carries no
	   node types, and this is all the tests need of it. */
	const host = (
		globalThis as unknown as {
			readonly process: {
				on(event: 'unhandledRejection', listener: RejectionListener): void;
				off(event: 'unhandledRejection', listener: RejectionListener): void;
			};
		}
	).process;

	async function answeredHits(
		contributions: readonly CommandSearchContribution[],
	): Promise<readonly CommandSearchHit[]> {
		const found = await runCommandSearch(
			contributions,
			'ad',
			new AbortController().signal,
		);
		return found.hits;
	}

	interface Activation {
		readonly by: string;
		readonly hit: CommandSearchHit;
	}

	function watched(
		id: string,
		reference: string,
		opened: Activation[],
		onOpen?: () => void | Promise<void>,
	): CommandSearchContribution {
		return {
			...contribution(id, async () => [hit('users.members', reference)]),
			onOpen: (entry) => {
				opened.push({ by: id, hit: entry });
				return onOpen?.();
			},
		};
	}

	/* What a module keeps when a record is opened is its own bookkeeping about
	   its own answer. A contribution that did not answer with the hit knows
	   nothing about it and must not be told a record it never found was opened. */
	it('tells the contribution that answered with the hit and nobody else', async () => {
		const opened: Activation[] = [];
		const hits = await answeredHits([
			watched('search.core.records', 'ada', opened),
			watched('documents.core.files', 'report', opened),
		]);

		commandSearchHitOpened(hits[1]!);

		expect(opened).toEqual([{ by: 'documents.core.files', hit: hits[1] }]);
	});

	it('tells it once for each activation', async () => {
		const opened: Activation[] = [];
		const hits = await answeredHits([
			watched('search.core.records', 'ada', opened),
		]);

		commandSearchHitOpened(hits[0]!);
		expect(opened).toHaveLength(1);

		commandSearchHitOpened(hits[0]!);
		expect(opened).toHaveLength(2);
	});

	it('tells nobody about a hit no contribution answered with', async () => {
		const opened: Activation[] = [];
		await answeredHits([watched('search.core.records', 'ada', opened)]);

		commandSearchHitOpened(hit('users.members', 'ada'));

		expect(opened).toEqual([]);
	});

	it('opens a hit from a contribution that declares no callback', async () => {
		const hits = await answeredHits([
			contribution('search.core.records', async () => [
				hit('search.core.records', 'ada'),
			]),
		]);

		expect(() => commandSearchHitOpened(hits[0]!)).not.toThrow();
	});

	/* The callback runs while the shell is already navigating. A rejection that
	   reached the page would be an unhandled one on the member's way to the
	   record, for bookkeeping they never asked about. */
	it('swallows a rejected callback', async () => {
		const opened: Activation[] = [];
		const unhandled: unknown[] = [];
		const collect = (reason: unknown) => unhandled.push(reason);
		const hits = await answeredHits([
			watched('search.core.records', 'ada', opened, async () => {
				throw new Error('recall is down');
			}),
		]);

		host.on('unhandledRejection', collect);
		expect(() => commandSearchHitOpened(hits[0]!)).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		host.off('unhandledRejection', collect);

		expect(opened).toHaveLength(1);
		expect(unhandled).toEqual([]);
	});

	it('swallows a callback that throws before it returns a promise', async () => {
		const opened: Activation[] = [];
		const hits = await answeredHits([
			watched('search.core.records', 'ada', opened, () => {
				throw new Error('recall is down');
			}),
		]);

		expect(() => commandSearchHitOpened(hits[0]!)).not.toThrow();
		expect(opened).toHaveLength(1);
	});
});

describe('what the palette says about the record section', () => {
	/* Every asked contribution failing leaves no list to show, so the failure
	   is the section; anything less keeps the hits that did arrive. */
	it('reads every asked contribution failing as a failure', () => {
		expect(commandSearchOutcome(2, 2)).toBe('error');
		expect(commandSearchOutcome(1, 1)).toBe('error');
	});

	it('reads some of them failing as an incomplete list', () => {
		expect(commandSearchOutcome(3, 1)).toBe('partial');
		expect(commandSearchOutcome(2, 1)).toBe('partial');
	});

	it('reads no failure as a complete list', () => {
		expect(commandSearchOutcome(3, 0)).toBe('ready');
		expect(commandSearchOutcome(0, 0)).toBe('ready');
	});
});

describe('opening the command palette', () => {
	it('reaches a subscribed shell and stops after it detaches', () => {
		const seeds: string[] = [];
		const detach = onOpenCommandPalette((seed) => seeds.push(seed));

		openCommandPalette();
		openCommandPalette('ada');
		detach();
		openCommandPalette('ignored');

		expect(seeds).toEqual(['', 'ada']);
	});

	it('does nothing when no shell is mounted', () => {
		expect(() => openCommandPalette('ada')).not.toThrow();
	});

	/* A throwing listener is the shell's own problem; the widget that asked has
	   nothing to do about it and must not see the failure. */
	it('isolates a listener that throws', () => {
		const seeds: string[] = [];
		const detachBad = onOpenCommandPalette(() => {
			throw new Error('shell is broken');
		});
		const detachGood = onOpenCommandPalette((seed) => seeds.push(seed));

		expect(() => openCommandPalette('ada')).not.toThrow();
		expect(seeds).toEqual(['ada']);

		detachBad();
		detachGood();
	});
});

describe('command search contributions in the registry', () => {
	it('collects them in declared order and leaves modules without one alone', () => {
		const registry = createClientContributionRegistry([
			{
				moduleId: 'search.core',
				commandSearch: contribution('search.core.records', async () => [], 10),
			},
			{ moduleId: 'users.core' },
			{
				moduleId: 'documents.core',
				commandSearch: contribution('documents.core.files', async () => [], 5),
			},
		]);

		expect(registry.commandSearch.map((entry) => entry.id)).toEqual([
			'documents.core.files',
			'search.core.records',
		]);
	});

	it('refuses two contributions under one id', () => {
		expect(() =>
			createClientContributionRegistry([
				{
					moduleId: 'search.core',
					commandSearch: contribution('records', async () => []),
				},
				{
					moduleId: 'documents.core',
					commandSearch: contribution('records', async () => []),
				},
			]),
		).toThrowError(/Duplicate client contribution command search id/);
	});

	it('answers an empty list when no module contributes one', () => {
		expect(
			createClientContributionRegistry([{ moduleId: 'users.core' }])
				.commandSearch,
		).toEqual([]);
	});
});
