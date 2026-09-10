import { describe, expect, it } from 'vitest';
import { diffFields, parseHistoryRequest } from '../src/record-history.ts';

/* The kernel owns the shared vocabulary only: the field diff and the query
   contract. Storage lives in @flowdular/database and is tested against a real
   PostgreSQL there. */
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

	it('records only the fields actually set on a creation', () => {
		expect(diffFields(null, { name: 'New', note: null })).toEqual({
			name: { from: null, to: 'New' },
		});
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
