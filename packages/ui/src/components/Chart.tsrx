import { useEffect, useRef, type OctaneNode } from 'octane';
import type { Chart as ChartJs, ChartConfiguration } from 'chart.js';
import { EmptyState } from './EmptyState.tsrx';

export type ChartType = 'area' | 'bar' | 'line';

export interface ChartSeries {
	readonly key: string;
	readonly label: string;
	/** Series color token, e.g. '--chart-2'. Defaults to --chart-N by position. */
	readonly token?: string;
}

export interface ChartProps<DataPoint = Record<string, unknown>> {
	readonly type: ChartType;
	readonly data: readonly DataPoint[];
	readonly series: readonly ChartSeries[];
	readonly xKey: string;
	readonly height?: number;
	/** Accessible name for the chart. */
	readonly title?: string;
	readonly xTickFormatter?: (value: string) => string;
	readonly valueFormatter?: (value: number) => string;
	readonly emptyIcon?: string;
	readonly emptyTitle?: string;
	readonly emptyHint?: OctaneNode;
}

interface ChartPalette {
	readonly series: readonly string[];
	readonly grid: string;
	readonly axis: string;
	readonly tick: string;
	readonly text: string;
	readonly surface: string;
	readonly ink: string;
	readonly primary: string;
}

const SERIES_TOKENS = [
	'--chart-1',
	'--chart-2',
	'--chart-3',
	'--chart-4',
	'--chart-5',
];

function readCell(point: unknown, key: string): unknown {
	return (point as Record<string, unknown>)[key];
}

function readNumber(point: unknown, key: string): number {
	const raw = readCell(point, key);
	const value =
		typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(value) ? value : 0;
}

function readLabel(point: unknown, key: string): string {
	const raw = readCell(point, key);
	return raw === null || raw === undefined ? '' : String(raw);
}

/* SVG/canvas colors ignore var(), so the token layer is read once on the client
   and passed to Chart.js as concrete values that follow the active theme. */
function readPalette(): ChartPalette {
	const root = getComputedStyle(document.documentElement);
	const read = (name: string) => root.getPropertyValue(name).trim();
	const primary = read('--primary');
	return {
		series: SERIES_TOKENS.map((token) => read(token) || primary),
		grid: read('--line-2') || read('--line'),
		axis: read('--line'),
		tick: read('--ink-3'),
		text: read('--ink-2'),
		surface: read('--surface'),
		ink: read('--ink'),
		primary,
	};
}

function seriesColor(
	palette: ChartPalette,
	series: ChartSeries,
	index: number,
): string {
	if (series.token) {
		const custom = getComputedStyle(document.documentElement).getPropertyValue(
			series.token,
		).trim();
		if (custom) return custom;
	}
	return palette.series[index % palette.series.length] ?? palette.primary;
}

function withAlpha(color: string, alpha: string): string {
	return /^#[0-9a-fA-F]{6}$/.test(color) ? color + alpha : color;
}

export function Chart<DataPoint = Record<string, unknown>>(
	props: ChartProps<DataPoint>,
) @{
	const height = props.height ?? 220;
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	const hasValue = props.data.some(
		(point) => props.series.some((entry) => readNumber(point, entry.key) !== 0),
	);
	const isEmpty =
		props.data.length === 0 || props.series.length === 0 || !hasValue;

	useEffect(() => {
		if (isEmpty) return;
		const canvas = canvasRef.current;
		const context = canvas?.getContext('2d');
		if (!context) return;

		let instance: ChartJs | null = null;
		let disposed = false;

		void (async () => {
			const { default: ChartJS } = await import('chart.js/auto');
			if (disposed) return;
			const palette = readPalette();
			const labels = props.data.map((point) => {
				const raw = readLabel(point, props.xKey);
				return props.xTickFormatter ? props.xTickFormatter(raw) : raw;
			});
			const showLegend = props.series.length > 1;
			const configuration: ChartConfiguration =
				props.type === 'bar'
					? {
							type: 'bar',
							data: {
								labels,
								datasets: props.series.map(
									(entry, index) => ({
										label: entry.label,
										data: props.data.map(
											(point) => readNumber(point, entry.key),
										),
										backgroundColor: seriesColor(palette, entry, index),
										borderRadius: 4,
										maxBarThickness: 48,
									}),
								),
							},
							options: {
								responsive: true,
								maintainAspectRatio: false,
								interaction: { mode: 'index', intersect: false },
								plugins: {
									legend: {
										display: showLegend,
										labels: {
											color: palette.text,
											boxWidth: 12,
											boxHeight: 12,
										},
									},
									tooltip: {
										backgroundColor: palette.surface,
										borderColor: palette.axis,
										borderWidth: 1,
										titleColor: palette.ink,
										bodyColor: palette.text,
										padding: 10,
									},
								},
								scales: {
									x: {
										grid: { display: false },
										border: { color: palette.axis },
										ticks: {
											color: palette.tick,
											maxRotation: 0,
											autoSkip: true,
										},
									},
									y: {
										beginAtZero: true,
										grid: { color: palette.grid },
										border: { display: false },
										ticks: { color: palette.tick, precision: 0 },
									},
								},
							},
						}
					: {
							type: 'line',
							data: {
								labels,
								datasets: props.series.map((entry, index) => {
									const color = seriesColor(palette, entry, index);
									return {
										label: entry.label,
										data: props.data.map(
											(point) => readNumber(point, entry.key),
										),
										borderColor: color,
										backgroundColor: props.type === 'area'
											? withAlpha(color, '24')
											: color,
										fill: props.type === 'area',
										tension: 0.3,
										borderWidth: 2,
										pointRadius: 0,
										pointHoverRadius: 3,
									};
								}),
							},
							options: {
								responsive: true,
								maintainAspectRatio: false,
								interaction: { mode: 'index', intersect: false },
								plugins: {
									legend: {
										display: showLegend,
										labels: {
											color: palette.text,
											boxWidth: 12,
											boxHeight: 12,
										},
									},
									tooltip: {
										backgroundColor: palette.surface,
										borderColor: palette.axis,
										borderWidth: 1,
										titleColor: palette.ink,
										bodyColor: palette.text,
										padding: 10,
									},
								},
								scales: {
									x: {
										grid: { display: false },
										border: { color: palette.axis },
										ticks: {
											color: palette.tick,
											maxRotation: 0,
											autoSkip: true,
										},
									},
									y: {
										beginAtZero: true,
										grid: { color: palette.grid },
										border: { display: false },
										ticks: { color: palette.tick, precision: 0 },
									},
								},
							},
						};
			instance = new ChartJS(context, configuration);
		})();

		return () => {
			disposed = true;
			if (instance) instance.destroy();
		};
	}, [isEmpty, props.type, props.data, props.series, height]);

	<figure class="ui-chart" aria-label={props.title ?? ''}>
		@if (isEmpty) {
			<EmptyState
				icon={props.emptyIcon ?? 'activity'}
				title={props.emptyTitle ?? 'No data yet'}
			>{props.emptyHint}</EmptyState>
		} @else {
			<div class="ui-chart__canvas" style={'height:' + String(height) + 'px'}>
				<canvas ref={canvasRef} />
			</div>
		}
	</figure>
}
