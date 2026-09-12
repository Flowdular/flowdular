import { describe, expect, it } from 'vitest';
import type { ExportListView } from '../src/domain/types.ts';
import {
	createExportsClientState,
	startableLists,
	startState,
} from '../src/client/state.ts';

function list(id: string, permitted: boolean): ExportListView {
	return {
		id,
		label: id,
		moduleId: id.split('.').slice(0, 2).join('.'),
		permitted,
	};
}

describe('the start control', () => {
	it('waits while the first read of the catalogue is in flight', () => {
		expect(startState('loading', [])).toBe('loading');
	});

	it('keeps what is on screen while a later read runs', () => {
		expect(startState('loading', [list('users.core.members', true)])).toBe(
			'ready',
		);
	});

	it('reports a refused catalogue as denied rather than as a failure', () => {
		expect(startState('denied', [])).toBe('denied');
		expect(startState('error', [])).toBe('error');
	});

	it('is empty when no module registered a list', () => {
		expect(startState('idle', [])).toBe('empty');
	});

	/* Offering a list the reader may not export could only produce a 403: the
	   server decides the same permission on the live principal. */
	it('is empty when every registered list needs a permission the reader lacks', () => {
		expect(startState('idle', [list('users.core.members', false)])).toBe(
			'empty',
		);
	});

	it('offers only the lists the reader may export', () => {
		const lists = [
			list('users.core.members', true),
			list('access.core.review', false),
			list('access.core.attestations', true),
		];

		expect(startableLists(lists).map((entry) => entry.id)).toEqual([
			'users.core.members',
			'access.core.attestations',
		]);
		expect(startState('idle', lists)).toBe('ready');
	});

	it('starts with no list chosen and nothing in flight', () => {
		const client = createExportsClientState();

		expect(client.store.get(client.state.selectedListId)).toBe('');
		expect(client.store.get(client.state.starting)).toBe(false);
		expect(client.store.get(client.state.lists)).toEqual([]);
		expect(client.store.get(client.state.listsStatus)).toBe('loading');
	});
});
