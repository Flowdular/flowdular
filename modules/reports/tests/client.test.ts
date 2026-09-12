import { describe, expect, it } from 'vitest';
import { REPORT_LIMITS, type WorkspaceReport } from '../src/domain/types.ts';
import {
	largestTiles,
	rangeTooWide,
	reportCaption,
	resolvedLabel,
	screenSurface,
} from '../src/client/presentation.ts';
import {
	REPORTS_SUMMARY_WIDGET,
	REPORTS_VIEWS,
	reportsNavigation,
} from '../src/client/navigation.ts';

function report(
	key: string,
	tiles: readonly (readonly [string, number])[],
): WorkspaceReport {
	return {
		key,
		moduleId: key.split('.')[0] + '.core',
		label: key,
		permission: key + '.read',
		tiles: tiles.map(([tileKey, value]) => ({
			key: tileKey,
			label: tileKey,
			value,
		})),
		series: [],
	};
}

/** A bundle the reader's locale holds, answering the key itself otherwise. */
function bundle(entries: Readonly<Record<string, string>>) {
	return (key: string, params?: Readonly<Record<string, string | number>>) => {
		const template = entries[key];
		if (template === undefined) return key;
		return Object.entries(params ?? {}).reduce(
			(text, [name, value]) => text.replaceAll('{' + name + '}', String(value)),
			template,
		);
	};
}

describe('REPORTS-WIDGET', () => {
	it('shows the three largest tiles of the whole report, biggest first', () => {
		const ranked = largestTiles(
			[
				report('metering.usage', [
					['requests', 40],
					['tokens', 900],
				]),
				report('agents.runs', [
					['runs', 12],
					['tokens', 500],
					['errors', 1],
				]),
			],
			3,
		);

		expect(ranked.map((entry) => [entry.report.key, entry.tile.key])).toEqual([
			['metering.usage', 'tokens'],
			['agents.runs', 'tokens'],
			['metering.usage', 'requests'],
		]);
	});

	it('orders equal values by provider and then tile, so the row does not shuffle', () => {
		const ranked = largestTiles(
			[
				report('zebra.one', [['b', 5]]),
				report('alpha.one', [
					['b', 5],
					['a', 5],
				]),
			],
			3,
		);

		expect(
			ranked.map((entry) => entry.report.key + '/' + entry.tile.key),
		).toEqual(['alpha.one/a', 'alpha.one/b', 'zebra.one/b']);
	});

	it('shows nothing rather than failing when no provider answered a tile', () => {
		expect(largestTiles([], 3)).toEqual([]);
		expect(largestTiles([report('metering.usage', [])], 3)).toEqual([]);
	});
});

describe('reports screen states', () => {
	it('picks one of the five states', () => {
		const populated = [report('metering.usage', [['requests', 1]])];
		expect(screenSurface('loading', [])).toBe('loading');
		expect(screenSurface('denied', populated)).toBe('denied');
		expect(screenSurface('error', populated)).toBe('error');
		expect(screenSurface('idle', [])).toBe('empty');
		expect(screenSurface('idle', [report('metering.usage', [])])).toBe('empty');
		expect(screenSurface('idle', populated)).toBe('ready');
	});

	/* A refresh over a report that is already on screen keeps the numbers
	   visible instead of blanking them back to the loading state. */
	it('keeps a loaded report on screen while it refreshes', () => {
		expect(
			screenSurface('loading', [report('metering.usage', [['requests', 1]])]),
		).toBe('ready');
	});

	/* A provider may answer lines and no number at all; that report is
	   something to render, not an empty screen. */
	it('renders a provider that answered only series', () => {
		const lines: WorkspaceReport = {
			...report('agents.runs', []),
			series: [
				{
					key: 'runs',
					label: 'Runs per day',
					points: [{ at: '2026-09-01', value: 2 }],
				},
			],
		};

		expect(screenSurface('idle', [lines])).toBe('ready');
		expect(screenSurface('loading', [lines])).toBe('ready');
	});
});

describe('REPORTS-RANGE screen bound', () => {
	/* The server refuses the same width; the screen refuses it first so the
	   reader is told without a request being spent on the answer. */
	it('refuses a range wider than the request bound and accepts the bound itself', () => {
		expect(rangeTooWide('2026-01-01', '2026-01-31')).toBe(false);
		/* 2025-08-08 to 2026-09-11 is exactly 400 days, both included. */
		expect(rangeTooWide('2025-08-08', '2026-09-11')).toBe(false);
		expect(rangeTooWide('2025-08-07', '2026-09-11')).toBe(true);
		expect(REPORT_LIMITS.rangeDays).toBe(400);
	});

	it('leaves an incomplete or unreadable range to the field and the server', () => {
		expect(rangeTooWide('', '2026-09-11')).toBe(false);
		expect(rangeTooWide('2026-09-11', '')).toBe(false);
		expect(rangeTooWide('not-a-day', '2026-09-11')).toBe(false);
	});
});

describe('REPORTS-LABELS screen', () => {
	/* The provider module owns its copy: reports.core renders the module's
	   translation when its bundle carries the key, and the literal the provider
	   registered when it does not, so a missing key never shows a raw key. */
	it('prefers the provider module translation and falls back to its literal', () => {
		const translate = bundle({
			'metering.report.usage.label': 'Zużycie w tym miesiącu',
		});

		expect(
			resolvedLabel(
				translate,
				'Usage this month',
				'metering.report.usage.label',
			),
		).toBe('Zużycie w tym miesiącu');
		expect(
			resolvedLabel(translate, 'Agent runs', 'agents.report.runs.label'),
		).toBe('Agent runs');
		expect(resolvedLabel(translate, 'Agent runs', undefined)).toBe(
			'Agent runs',
		);
		expect(resolvedLabel(translate, 'Agent runs', '')).toBe('Agent runs');
	});
});

describe('REPORTS-PERIOD caption', () => {
	const translate = bundle({
		'reports.report.range': '{module} · {from}-{to}',
	});
	const day = (value: string) => value.slice(5);
	const asked = { from: '2026-08-14', to: '2026-09-12' };

	/* A provider that rolls up by its own period is captioned with that period;
	   anything else is captioned with the range the reader asked for. */
	it('captions a card with the provider period when it answered one', () => {
		const own: WorkspaceReport = {
			...report('metering.usage', [['requests', 1]]),
			period: { from: '2026-09-01', to: '2026-09-30' },
		};

		expect(reportCaption(translate, day, own, asked)).toBe(
			'metering.core · 09-01-09-30',
		);
	});

	it('captions a card with the request range when the provider named none', () => {
		expect(
			reportCaption(translate, day, report('agents.runs', []), asked),
		).toBe('agents.core · 08-14-09-12');
	});

	it('names the module alone before the first range is known', () => {
		expect(reportCaption(translate, day, report('agents.runs', []), null)).toBe(
			'agents.core',
		);
	});
});

describe('reports contribution', () => {
	it('points its navigation and widget at the registered view and slot', () => {
		expect(reportsNavigation.map((entry) => entry.viewId)).toEqual([
			REPORTS_VIEWS.reports,
		]);
		expect(reportsNavigation[0]!.group).toBe('Administration');
		expect(reportsNavigation[0]!.scope).toBe('reports.workspace.read');
		expect(REPORTS_SUMMARY_WIDGET.slot).toBe('dashboard.metrics');
		expect(REPORTS_SUMMARY_WIDGET.scope).toBe('reports.workspace.read');
	});
});
