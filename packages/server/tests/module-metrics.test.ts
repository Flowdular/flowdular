import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '../src/index.ts';

function seriesValue(exposition: string, series: string): number | undefined {
	for (const line of exposition.split('\n')) {
		if (line.startsWith(`${series} `))
			return Number(line.slice(series.length + 1));
	}
	return undefined;
}

function seriesLines(exposition: string, prefix: string): string[] {
	return exposition.split('\n').filter((line) => line.startsWith(prefix));
}

describe('module metrics', () => {
	it('prefixes every series with the module id', () => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('agents.core').counter('runs_started');

		expect(
			seriesValue(
				registry.expose(),
				'flowdular_module_agents_core_runs_started_total',
			),
		).toBe(1);
	});

	it('counts once per call and keeps label sets apart', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('notifications.core');
		metrics.counter('delivered', { channel: 'inbox' });
		metrics.counter('delivered', { channel: 'inbox' });
		metrics.counter('delivered', { channel: 'webhook' });
		const exposition = registry.expose();

		expect(
			seriesValue(
				exposition,
				'flowdular_module_notifications_core_delivered_total{channel="inbox"}',
			),
		).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_module_notifications_core_delivered_total{channel="webhook"}',
			),
		).toBe(1);
	});

	it('reads one label set whatever order the module wrote it in', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('import.core');
		metrics.counter('rows', { kind: 'csv', outcome: 'ok' });
		metrics.counter('rows', { outcome: 'ok', kind: 'csv' });

		expect(
			seriesLines(registry.expose(), 'flowdular_module_import_core_rows_total'),
		).toEqual([
			'flowdular_module_import_core_rows_total{kind="csv",outcome="ok"} 2',
		]);
	});

	it('observes a histogram into the request buckets', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('workflows.core');
		metrics.histogram('node_seconds', 0.02);
		metrics.histogram('node_seconds', 3);
		const exposition = registry.expose();

		expect(
			seriesValue(
				exposition,
				'flowdular_module_workflows_core_node_seconds_bucket{le="0.025"}',
			),
		).toBe(1);
		expect(
			seriesValue(
				exposition,
				'flowdular_module_workflows_core_node_seconds_bucket{le="+Inf"}',
			),
		).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_module_workflows_core_node_seconds_count',
			),
		).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_module_workflows_core_node_seconds_sum',
			),
		).toBe(3.02);
	});

	it('keeps a labelled histogram bucket label beside the module labels', () => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('audit.core').histogram('sweep_seconds', 0.5, {
			data_class: 'events',
		});

		expect(
			seriesValue(
				registry.expose(),
				'flowdular_module_audit_core_sweep_seconds_bucket{data_class="events",le="0.5"}',
			),
		).toBe(1);
	});

	it('stops at 2000 label sets per family and counts every refusal', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('metering.core');
		for (let index = 0; index < 2_010; index += 1) {
			metrics.counter('buckets', { tenant: `t${index}` });
		}
		const exposition = registry.expose();

		expect(
			seriesLines(exposition, 'flowdular_module_metering_core_buckets_total{'),
		).toHaveLength(2_000);
		expect(
			seriesValue(exposition, 'flowdular_metrics_dropped_samples_total'),
		).toBe(10);
	});

	it('stops opening families past the ceiling', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('rogue.core');
		for (let index = 0; index < 260; index += 1) {
			metrics.counter(`series_${index}`);
		}
		const exposition = registry.expose();

		expect(
			seriesLines(exposition, 'flowdular_module_rogue_core_series_'),
		).toHaveLength(256);
		expect(
			seriesValue(exposition, 'flowdular_metrics_dropped_samples_total'),
		).toBe(4);
	});

	it.each([
		['an upper case name', 'RunsStarted'],
		['a dotted name', 'runs.started'],
		['a name that starts with a digit', '1runs'],
		['a name over the bound', 'a'.repeat(65)],
	])('refuses %s rather than exposing it', (_label, name) => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('agents.core').counter(name);
		const exposition = registry.expose();

		expect(
			seriesLines(exposition, 'flowdular_module_agents_core'),
		).toHaveLength(0);
		expect(
			seriesValue(exposition, 'flowdular_metrics_dropped_samples_total'),
		).toBe(1);
	});

	it('refuses a label name it cannot expose and more labels than the bound', () => {
		const registry = createMetricsRegistry();
		const metrics = registry.moduleMetrics('agents.core');
		metrics.counter('runs', { 'Not Valid': 'x' });
		metrics.counter(
			'runs',
			Object.fromEntries(
				Array.from({ length: 9 }, (_, index) => [`l${index}`, 'v']),
			),
		);

		expect(
			seriesValue(registry.expose(), 'flowdular_metrics_dropped_samples_total'),
		).toBe(2);
	});

	it('escapes a label value and bounds its length', () => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('agents.core').counter('runs', {
			reason: `a"b\\c${'x'.repeat(200)}`,
		});
		const [line] = seriesLines(
			registry.expose(),
			'flowdular_module_agents_core_runs_total{',
		);

		expect(line).toContain('a\\"b\\\\c');
		expect(line?.length).toBeLessThan(200);
	});

	it('keeps a control character in a label from forging a series', () => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('agents.core').counter('runs', {
			reason: `a${String.fromCharCode(13)}b${String.fromCharCode(10)}c`,
		});
		const exposition = registry.expose();
		const [line] = seriesLines(
			exposition,
			'flowdular_module_agents_core_runs_total{',
		);

		/* A raw carriage return is not exposition a scrape can parse, so it never
		   leaves the registry; the newline beside it is escaped, which the format
		   does carry. */
		expect(line).toContain('reason="a b\\nc"');
		expect(exposition).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
	});

	it('sanitizes a module id that is not a metric name', () => {
		const registry = createMetricsRegistry();
		registry.moduleMetrics('Acme-Billing.v2').counter('invoices');

		expect(
			seriesValue(
				registry.expose(),
				'flowdular_module_acme_billing_v2_invoices_total',
			),
		).toBe(1);
	});

	it('never disturbs the request series', () => {
		const registry = createMetricsRegistry();
		registry.recordHttpRequest({
			endpoint: 'system.health',
			method: 'GET',
			status: 200,
			durationSeconds: 0.01,
		});
		registry.moduleMetrics('agents.core').counter('runs');
		const exposition = registry.expose();

		expect(
			seriesValue(
				exposition,
				'flowdular_http_requests_total{endpoint="system.health",method="GET",status="2xx"}',
			),
		).toBe(1);
		expect(
			seriesValue(exposition, 'flowdular_module_agents_core_runs_total'),
		).toBe(1);
	});
});
