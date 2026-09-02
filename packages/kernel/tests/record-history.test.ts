import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	appendHistory,
	diffFields,
	inTransaction,
	parseHistoryRequest,
	queryHistory,
} from '../src/record-history.ts';

const TABLE = 'records_history';

function database(serviceActors = false): DatabaseSync {
	const value = new DatabaseSync(':memory:');
	value.exec(`CREATE TABLE records_history (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		record_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		action TEXT NOT NULL,
		actor_kind TEXT NOT NULL,
		actor_id TEXT NOT NULL,
		actor_label TEXT NOT NULL,
		run_id TEXT,
		${serviceActors ? 'configured_by_json TEXT,' : ''}
		changes_json TEXT NOT NULL,
		occurred_at INTEGER NOT NULL,
		UNIQUE (tenant_id, record_id, version)
	) STRICT;`);
	return value;
}

describe('record history', () => {
	it('stores only changed fields', () => {
		expect(
			diffFields(
				{ name: 'Old', status: 'active', note: null },
				{ name: 'New', status: 'active', note: 'Added' },
			),
		).toEqual({
			name: { from: 'Old', to: 'New' },
			note: { from: null, to: 'Added' },
		});
	});

	it('round-trips service actors with their configuring user', () => {
		const value = database(true);
		appendHistory(value, TABLE, {
			tenantId: 'tenant-a',
			recordId: 'record-1',
			action: 'updated',
			actor: {
				kind: 'service',
				id: 'schedule-1',
				label: 'Nightly reconciliation',
				configuredBy: {
					kind: 'user',
					id: 'account-1',
					label: 'Ada',
				},
			},
			changes: { status: { from: 'open', to: 'settled' } },
			occurredAt: 10,
		});

		expect(
			queryHistory(value, TABLE, {
				tenantId: 'tenant-a',
				recordId: 'record-1',
				limit: 10,
			}).entries[0]?.actor,
		).toEqual({
			kind: 'service',
			id: 'schedule-1',
			label: 'Nightly reconciliation',
			configuredBy: { kind: 'user', id: 'account-1', label: 'Ada' },
		});
	});

	it('refuses to erase service provenance in a legacy history table', () => {
		const value = database();
		expect(() =>
			appendHistory(value, TABLE, {
				tenantId: 'tenant-a',
				recordId: 'record-1',
				action: 'updated',
				actor: {
					kind: 'service',
					id: 'schedule-1',
					label: 'Nightly reconciliation',
					configuredBy: { kind: 'user', id: 'account-1', label: 'Ada' },
				},
				changes: {},
				occurredAt: 10,
			}),
		).toThrow('must add configured_by_json');
	});

	it('increments versions per tenant and record and pages newest first', () => {
		const value = database();
		const actor = { kind: 'user', id: 'account-1', label: 'Ada' } as const;
		for (const [tenantId, action, occurredAt] of [
			['tenant-a', 'created', 1],
			['tenant-a', 'updated', 2],
			['tenant-a', 'archived', 3],
			['tenant-b', 'created', 4],
		] as const) {
			appendHistory(value, TABLE, {
				tenantId,
				recordId: 'record-1',
				action,
				actor,
				changes: { status: { from: null, to: action } },
				occurredAt,
			});
		}

		const first = queryHistory(value, TABLE, {
			tenantId: 'tenant-a',
			recordId: 'record-1',
			limit: 2,
		});
		expect(first.entries.map((entry) => [entry.version, entry.action])).toEqual(
			[
				[3, 'archived'],
				[2, 'updated'],
			],
		);
		expect(first.nextCursor).toBe('2');
		expect(
			queryHistory(value, TABLE, {
				tenantId: 'tenant-a',
				recordId: 'record-1',
				limit: 2,
				cursor: first.nextCursor,
			}).entries.map((entry) => entry.action),
		).toEqual(['created']);
		expect(
			queryHistory(value, TABLE, {
				tenantId: 'tenant-c',
				recordId: 'record-1',
				limit: 20,
			}).entries,
		).toEqual([]);
	});

	it('keeps the record mutation and history write atomic', () => {
		const value = database();
		value.exec('CREATE TABLE records (id TEXT PRIMARY KEY) STRICT;');
		expect(() =>
			inTransaction(value, () => {
				value.prepare('INSERT INTO records (id) VALUES (?)').run('record-1');
				throw new Error('history failed');
			}),
		).toThrow('history failed');
		expect(value.prepare('SELECT id FROM records').all()).toEqual([]);
	});

	it('parses the bounded shared history query contract', () => {
		expect(
			parseHistoryRequest(
				new URLSearchParams('recordId=record-1&limit=20&cursor=4'),
			),
		).toEqual({ recordId: 'record-1', limit: 20, cursor: '4' });
		expect(parseHistoryRequest(new URLSearchParams())).toBeNull();
		expect(
			parseHistoryRequest(new URLSearchParams(`recordId=${'x'.repeat(129)}`)),
		).toBeNull();
	});
});
