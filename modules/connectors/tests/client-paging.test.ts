import { describe, expect, it } from 'vitest';
import type { ConnectorCallListRow } from '../src/domain/types.ts';
import {
	beginLoad,
	createConnectorCallsClientState,
	createConnectorsClientState,
	FIRST_PAGE,
	instanceChoices,
	isLatestLoad,
	pageCursor,
	searchPending,
	sortRequest,
	walkTo,
} from '../src/client/state.ts';

function call(id: string, instanceId: string, instanceName: string | null) {
	return {
		id,
		tenantId: 'tenant-a',
		instanceId,
		instanceName,
		operation: 'get',
		caller: 'test',
		callerRef: null,
		outcome: 'succeeded',
		status: 200,
		errorClass: null,
		durationMs: 1,
		requestBytes: 0,
		responseBytes: 0,
		occurredAt: 1,
	} satisfies ConnectorCallListRow;
}

describe('connectors load tickets', () => {
	it('applies only the newest load when two overlap', () => {
		const client = createConnectorsClientState();
		const first = beginLoad(client.store, client.state.loads);
		const second = beginLoad(client.store, client.state.loads);
		expect(second).toBe(first + 1);
		/* The older answer lands after the newer request started. */
		expect(isLatestLoad(client.store, client.state.loads, first)).toBe(false);
		expect(isLatestLoad(client.store, client.state.loads, second)).toBe(true);
		const third = beginLoad(client.store, client.state.loads);
		expect(isLatestLoad(client.store, client.state.loads, second)).toBe(false);
		expect(isLatestLoad(client.store, client.state.loads, third)).toBe(true);
	});

	it('keeps a ticket per screen', () => {
		const calls = createConnectorCallsClientState();
		const instances = createConnectorsClientState();
		const ticket = beginLoad(calls.store, calls.state.loads);
		beginLoad(instances.store, instances.state.loads);
		expect(isLatestLoad(calls.store, calls.state.loads, ticket)).toBe(true);
	});
});

describe('connectors instance filter choices', () => {
	it('offers each instance the page names once, by name, plus the one chosen', () => {
		const rows = [
			call('c1', 'i-billing', 'Billing'),
			call('c2', 'i-crm', 'CRM'),
			call('c3', 'i-billing', 'Billing'),
			call('c4', 'i-gone', null),
		];
		expect(instanceChoices(rows, '')).toEqual([
			{ value: 'i-billing', label: 'Billing' },
			{ value: 'i-crm', label: 'CRM' },
			{ value: 'i-gone', label: 'i-gone' },
		]);
		expect(instanceChoices(rows, 'i-crm')).toHaveLength(3);
		expect(instanceChoices([], 'i-other')).toEqual([
			{ value: 'i-other', label: 'i-other' },
		]);
	});
});

describe('connectors page walk', () => {
	it('starts without a cursor and records the cursor that opens each page', () => {
		expect(pageCursor(FIRST_PAGE)).toBeNull();
		const second = walkTo(FIRST_PAGE, 1, 'c1');
		expect(second).toEqual({ pageIndex: 1, cursors: [null, 'c1'] });
		expect(pageCursor(second)).toBe('c1');
		const third = walkTo(second, 2, 'c2');
		expect(third).toEqual({ pageIndex: 2, cursors: [null, 'c1', 'c2'] });
		expect(pageCursor(third)).toBe('c2');
	});

	it('reuses the stored cursor going back and the fresh one going forward again', () => {
		const third = walkTo(walkTo(FIRST_PAGE, 1, 'c1'), 2, 'c2');
		const back = walkTo(third, 1, null);
		expect(back.pageIndex).toBe(1);
		expect(pageCursor(back)).toBe('c1');
		expect(pageCursor(walkTo(back, 0, null))).toBeNull();
		/* The page on screen handed out a newer cursor for the next page, so it
		   replaces the one recorded before the reader went back. */
		expect(walkTo(back, 2, 'c2-fresh')).toEqual({
			pageIndex: 2,
			cursors: [null, 'c1', 'c2-fresh'],
		});
		expect(walkTo(back, 2, null)).toEqual({
			pageIndex: 2,
			cursors: [null, 'c1', 'c2'],
		});
	});

	it('stays where it is for the same page, a page nobody opened, or no cursor', () => {
		const second = walkTo(FIRST_PAGE, 1, 'c1');
		expect(walkTo(second, 1, 'c2')).toBe(second);
		expect(walkTo(second, 3, 'c2')).toBe(second);
		expect(walkTo(second, 2, null)).toBe(second);
		expect(walkTo(FIRST_PAGE, -1, null)).toBe(FIRST_PAGE);
		expect(walkTo(FIRST_PAGE, Number.NaN, 'c1')).toBe(FIRST_PAGE);
	});

	it('resets to the first page for a new listing', () => {
		const deep = walkTo(walkTo(FIRST_PAGE, 1, 'c1'), 2, 'c2');
		expect(deep.pageIndex).toBe(2);
		expect(FIRST_PAGE).toEqual({ pageIndex: 0, cursors: [null] });
		expect(pageCursor(FIRST_PAGE)).toBeNull();
	});
});

describe('connectors list request', () => {
	it('maps the table order onto the server sort and direction', () => {
		const fallback = { key: 'name', desc: false };
		expect(sortRequest([], fallback)).toEqual({
			sort: 'name',
			direction: 'asc',
		});
		expect(sortRequest([{ key: 'name', desc: true }], fallback)).toEqual({
			sort: 'name',
			direction: 'desc',
		});
		expect(
			sortRequest([{ key: 'occurredAt', desc: false }], {
				key: 'occurredAt',
				desc: true,
			}),
		).toEqual({ sort: 'occurredAt', direction: 'asc' });
	});

	it('reports a search term the rows do not answer yet', () => {
		expect(searchPending('', '')).toBe(false);
		expect(searchPending('  bill ', 'bill')).toBe(false);
		expect(searchPending('billing', 'bill')).toBe(true);
	});
});
