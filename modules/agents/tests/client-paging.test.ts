import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../src/domain/types.ts';
import {
	agentSorting,
	DEFAULT_AGENT_SORT,
	FIRST_PAGE,
	hasMorePages,
	mergeAgentOptions,
	moveToPage,
	pageCursor,
	pageLoaded,
	runDirection,
} from '../src/client/state.ts';

function run(id: string, agentId: string, agentName: string): AgentRun {
	return { id, agentId, agentName } as AgentRun;
}

describe('agents client cursor stack', () => {
	it('walks forward on the cursors the server handed out and back on the stored ones', () => {
		expect(pageCursor(FIRST_PAGE)).toBeNull();
		expect(hasMorePages(FIRST_PAGE)).toBe(false);
		/* Next stays closed until the page on screen has reported what follows. */
		expect(moveToPage(FIRST_PAGE, 1)).toBe(FIRST_PAGE);

		const first = pageLoaded(FIRST_PAGE, 'c1');
		expect(hasMorePages(first)).toBe(true);
		const second = moveToPage(first, 1);
		expect(second.pageIndex).toBe(1);
		expect(pageCursor(second)).toBe('c1');
		expect(hasMorePages(second)).toBe(false);
		const secondLoaded = pageLoaded(second, 'c2');
		const third = moveToPage(secondLoaded, 2);
		expect(pageCursor(third)).toBe('c2');

		const back = moveToPage(pageLoaded(third, null), 1);
		expect(pageCursor(back)).toBe('c1');
		expect(hasMorePages(back)).toBe(true);
		expect(pageCursor(moveToPage(back, 0))).toBeNull();
		expect(moveToPage(back, -3).pageIndex).toBe(0);
		expect(moveToPage(back, 9).pageIndex).toBe(2);
	});

	it('forgets the pages behind a page that ended the list', () => {
		const deep = moveToPage(
			pageLoaded(moveToPage(pageLoaded(FIRST_PAGE, 'c1'), 1), 'c2'),
			2,
		);
		const ended = pageLoaded(moveToPage(deep, 1), null);
		expect(ended.cursors).toEqual([null, 'c1']);
		expect(hasMorePages(ended)).toBe(false);
		expect(moveToPage(ended, 2).pageIndex).toBe(1);
	});

	it('resets to the first page when a filter or sort changes', () => {
		const deep = moveToPage(pageLoaded(FIRST_PAGE, 'c1'), 1);
		expect(deep.pageIndex).toBe(1);
		/* The screen replaces the stack with FIRST_PAGE on every such change. */
		expect(FIRST_PAGE).toEqual({ pageIndex: 0, cursors: [null] });
		expect(pageCursor(FIRST_PAGE)).toBeNull();
	});

	it('maps the table sort onto the request and falls back to the default', () => {
		expect(agentSorting([])).toBe(DEFAULT_AGENT_SORT);
		expect(agentSorting([{ key: 'updatedAt', desc: true }])).toEqual([
			{ key: 'updatedAt', desc: true },
		]);
		expect(agentSorting([{ key: 'model', desc: true }])).toBe(
			DEFAULT_AGENT_SORT,
		);
		expect(runDirection([])).toBe('desc');
		expect(runDirection([{ key: 'queuedAt', desc: false }])).toBe('asc');
		expect(runDirection([{ key: 'status', desc: false }])).toBe('desc');
	});

	it('keeps every agent seen in a loaded page as a filter option', () => {
		const options = mergeAgentOptions(
			[],
			[run('r1', 'a2', 'Zeta'), run('r2', 'a1', 'Alpha')],
		);
		expect(options).toEqual([
			{ id: 'a1', name: 'Alpha' },
			{ id: 'a2', name: 'Zeta' },
		]);
		expect(mergeAgentOptions(options, [run('r3', 'a1', 'Alpha')])).toBe(
			options,
		);
		expect(
			mergeAgentOptions(options, [run('r4', 'a3', 'Beta')]).map(
				(option) => option.id,
			),
		).toEqual(['a1', 'a3', 'a2']);
	});
});
