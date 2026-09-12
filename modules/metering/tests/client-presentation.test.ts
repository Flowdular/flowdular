import { describe, expect, it } from 'vitest';
import type { MeterUsage } from '../src/domain/types.ts';
import {
	screenSurface,
	usageShare,
	usageTone,
} from '../src/client/presentation.ts';
import type { ScreenStatus } from '../src/client/state.ts';

const WARNING_PERCENT = 80;

function usage(used: number, limit: number | null): MeterUsage {
	return {
		meter: {
			id: 'meter-1',
			tenantId: 'tenant-1',
			key: 'agents.core.run-tokens',
			moduleId: 'agents.core',
			label: 'Run tokens',
			unit: 'tokens',
			kind: 'cumulative',
			createdAt: 0,
		},
		month: '2026-09',
		used,
		limit,
	};
}

describe('metering screen surface', () => {
	/* A failed load leaves the reader with an alert and the table's own empty
	   copy under it, which says this workspace has no meters. It has meters;
	   the request failed. Only one of the two can be true, so only the alert
	   is rendered. */
	it('shows the alert alone when the load failed', () => {
		expect(screenSurface('error')).toBe('error');
	});

	it('keeps the records for every status that is not a failure', () => {
		for (const status of [
			'idle',
			'loading',
		] as const satisfies readonly ScreenStatus[]) {
			expect([status, screenSurface(status)]).toEqual([status, 'records']);
		}
	});

	it('shows the denial instead of the records for a refused read', () => {
		expect(screenSurface('denied')).toBe('denied');
	});
});

describe('METERING-ZERO-LIMIT', () => {
	/* A ceiling of zero is the operator closing a meter, which is the strongest
	   state a screen can show. Reading it as "no share" painted it exactly like
	   an unlimited meter, and the dashboard tile carried no badge. */
	it('METERING-ZERO-LIMIT reads a closed meter as fully consumed', () => {
		expect(usageShare(usage(0, 0))).toBe(100);
		expect(usageShare(usage(7, 0))).toBe(100);
	});

	it('METERING-ZERO-LIMIT paints a closed meter in the danger tone', () => {
		expect(usageTone(usage(0, 0), WARNING_PERCENT)).toBe('danger');
	});

	/* The badge the dashboard tile shows, as UsageSummaryWidget computes it. */
	it('METERING-ZERO-LIMIT puts the attention badge on a closed meter', () => {
		expect((usageShare(usage(7, 0)) ?? 0) >= WARNING_PERCENT).toBe(true);
	});

	it('leaves an unlimited meter without a share or a tone', () => {
		expect(usageShare(usage(7, null))).toBeNull();
		expect(usageTone(usage(7, null), WARNING_PERCENT)).toBe('neutral');
	});

	it('keeps the share of a limit that allows something', () => {
		expect(usageShare(usage(40, 100))).toBe(40);
		expect(usageTone(usage(40, 100), WARNING_PERCENT)).toBe('success');
		expect(usageTone(usage(80, 100), WARNING_PERCENT)).toBe('warning');
		expect(usageTone(usage(100, 100), WARNING_PERCENT)).toBe('danger');
	});
});
