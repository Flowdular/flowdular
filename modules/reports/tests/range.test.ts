import { describe, expect, it } from 'vitest';
import { REPORT_LIMITS } from '../src/domain/types.ts';
import { readReportRange } from '../src/services/range.ts';
import { ReportsServiceError } from '../src/services/service-error.ts';

const NOW = Date.parse('2026-09-12T11:30:00Z');

function refusal(input: { from?: string | null; to?: string | null }): string {
	try {
		readReportRange(input, NOW);
	} catch (error) {
		return error instanceof ReportsServiceError ? error.code : 'NOT_SERVICE';
	}
	return 'NO_ERROR';
}

describe('REPORTS-RANGE', () => {
	it('defaults to the 30 day window ending today', () => {
		expect(readReportRange({}, NOW)).toEqual({
			from: '2026-08-14',
			to: '2026-09-12',
		});
	});

	it('treats an absent side as unset, not as an empty day', () => {
		expect(readReportRange({ from: null, to: '' }, NOW)).toEqual({
			from: '2026-08-14',
			to: '2026-09-12',
		});
		expect(readReportRange({ from: '2026-09-01' }, NOW)).toEqual({
			from: '2026-09-01',
			to: '2026-09-12',
		});
		expect(readReportRange({ to: '2026-03-31' }, NOW)).toEqual({
			from: '2026-03-02',
			to: '2026-03-31',
		});
	});

	it('refuses a reversed, malformed or over-wide range', () => {
		expect(refusal({ from: '2026-09-12', to: '2026-09-11' })).toBe(
			'INVALID_RANGE',
		);
		expect(refusal({ from: 'yesterday', to: '2026-09-12' })).toBe(
			'INVALID_RANGE',
		);
		expect(refusal({ from: '2026-13-01', to: '2026-09-12' })).toBe(
			'INVALID_RANGE',
		);
		expect(refusal({ from: '2020-01-01', to: '2026-09-12' })).toBe(
			'INVALID_RANGE',
		);
	});

	/* The widest accepted range is the point bound, which is what lets a daily
	   series stay inside one provider answer. */
	it('accepts exactly the widest range and refuses one day more', () => {
		const to = '2026-09-12';
		const widest = new Date(
			Date.parse(`${to}T00:00:00Z`) -
				(REPORT_LIMITS.rangeDays - 1) * 86_400_000,
		)
			.toISOString()
			.slice(0, 10);
		expect(readReportRange({ from: widest, to }, NOW)).toEqual({
			from: widest,
			to,
		});
		const wider = new Date(
			Date.parse(`${to}T00:00:00Z`) - REPORT_LIMITS.rangeDays * 86_400_000,
		)
			.toISOString()
			.slice(0, 10);
		expect(refusal({ from: wider, to })).toBe('INVALID_RANGE');
	});

	it('accepts a single day', () => {
		expect(
			readReportRange({ from: '2026-09-12', to: '2026-09-12' }, NOW),
		).toEqual({ from: '2026-09-12', to: '2026-09-12' });
	});
});
