import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface HttpRequestSample {
	/** Endpoint id, never the request path: a path carries record ids. */
	readonly endpoint: string;
	readonly method: string;
	readonly status: number;
	readonly durationSeconds: number;
}

export interface MetricsRegistry {
	/** Called once per served request; never throws into the request path. */
	recordHttpRequest(sample: HttpRequestSample): void;
	setBuildVersion(version: string): void;
	/** Prometheus text exposition, format version 0.0.4. */
	expose(): string;
}

/* One request writes at most one counter series and one histogram series, so a
   deployment that composes more endpoints than this stops admitting new label
   sets instead of growing. The refused samples are published as their own
   counter, so a scrape shows that the ceiling was reached. */
const MAX_SERIES = 2_000;
const MAX_LABEL = 128;
const BUCKETS = Object.freeze([
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);
const BUCKET_LABELS = Object.freeze(BUCKETS.map((bound) => String(bound)));
const METHODS = new Set([
	'GET',
	'HEAD',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
]);
const UNSAFE_LABEL = /["\\\n]/;
const SEPARATOR = '\u0000';

interface RequestCounter {
	readonly endpoint: string;
	readonly method: string;
	readonly status: string;
	count: number;
}

interface DurationHistogram {
	readonly endpoint: string;
	readonly buckets: number[];
	count: number;
	sum: number;
}

function labelValue(value: string): string {
	const bounded = value.length <= MAX_LABEL ? value : value.slice(0, MAX_LABEL);
	return UNSAFE_LABEL.test(bounded)
		? bounded.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
		: bounded;
}

/* A status class instead of the status keeps the label set bounded by a
   constant, and an unknown method keeps a hostile request line from opening a
   series of its own. */
function statusClass(status: number): string {
	return Number.isInteger(status) && status >= 100 && status < 600
		? `${Math.floor(status / 100)}xx`
		: 'unknown';
}

function methodLabel(method: string): string {
	const normalized = method.toUpperCase();
	return METHODS.has(normalized) ? normalized : 'other';
}

let eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null | undefined;

/* Sampling starts on the first scrape, never at import: a deployment that does
   not expose metrics must not pay for the timer. The histogram is drained on
   every read, so a scrape reports the interval since the previous one and a
   scrape with no sample yet reports zero. */
function eventLoopLagSeconds(): number | null {
	if (eventLoopDelay === undefined) {
		try {
			eventLoopDelay =
				typeof monitorEventLoopDelay === 'function'
					? monitorEventLoopDelay({ resolution: 10 })
					: null;
			eventLoopDelay?.enable();
		} catch {
			eventLoopDelay = null;
		}
	}
	if (!eventLoopDelay) return null;
	const mean = eventLoopDelay.mean;
	eventLoopDelay.reset();
	return Number.isFinite(mean) ? mean / 1e9 : 0;
}

function residentMemoryBytes(): number | null {
	try {
		const rss = process.memoryUsage.rss();
		return Number.isFinite(rss) ? rss : null;
	} catch {
		return null;
	}
}

export function createMetricsRegistry(): MetricsRegistry {
	const counters = new Map<string, RequestCounter>();
	const durations = new Map<string, DurationHistogram>();
	const startTimeSeconds = Date.now() / 1000 - process.uptime();
	let dropped = 0;
	let version: string | null = null;

	const recordHttpRequest = (sample: HttpRequestSample): void => {
		const endpoint = labelValue(sample.endpoint);
		const method = methodLabel(sample.method);
		const status = statusClass(sample.status);
		const key = `${endpoint}${SEPARATOR}${method}${SEPARATOR}${status}`;
		const counter = counters.get(key);
		let timing = durations.get(endpoint);
		/* A sample is admitted or refused whole, so the counter and the histogram
		   can never disagree about a request that was served. */
		if (
			(!counter && counters.size >= MAX_SERIES) ||
			(!timing && durations.size >= MAX_SERIES)
		) {
			dropped += 1;
			return;
		}
		if (counter) counter.count += 1;
		else counters.set(key, { endpoint, method, status, count: 1 });

		if (!timing) {
			timing = {
				endpoint,
				buckets: new Array<number>(BUCKETS.length).fill(0),
				count: 0,
				sum: 0,
			};
			durations.set(endpoint, timing);
		}
		const seconds =
			Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0
				? sample.durationSeconds
				: 0;
		timing.count += 1;
		timing.sum += seconds;
		for (let index = 0; index < BUCKETS.length; index += 1) {
			if (seconds <= BUCKETS[index]!) {
				timing.buckets[index]! += 1;
				break;
			}
		}
	};

	const expose = (): string => {
		const lines: string[] = [
			'# HELP flowdular_http_requests_total Requests completed by a defined endpoint.',
			'# TYPE flowdular_http_requests_total counter',
		];
		for (const series of counters.values()) {
			lines.push(
				`flowdular_http_requests_total{endpoint="${series.endpoint}",method="${series.method}",status="${series.status}"} ${series.count}`,
			);
		}
		lines.push(
			'# HELP flowdular_http_request_duration_seconds Endpoint handler duration in seconds.',
			'# TYPE flowdular_http_request_duration_seconds histogram',
		);
		for (const series of durations.values()) {
			let cumulative = 0;
			for (let index = 0; index < BUCKETS.length; index += 1) {
				cumulative += series.buckets[index]!;
				lines.push(
					`flowdular_http_request_duration_seconds_bucket{endpoint="${series.endpoint}",le="${BUCKET_LABELS[index]!}"} ${cumulative}`,
				);
			}
			lines.push(
				`flowdular_http_request_duration_seconds_bucket{endpoint="${series.endpoint}",le="+Inf"} ${series.count}`,
				`flowdular_http_request_duration_seconds_sum{endpoint="${series.endpoint}"} ${series.sum}`,
				`flowdular_http_request_duration_seconds_count{endpoint="${series.endpoint}"} ${series.count}`,
			);
		}
		lines.push(
			'# HELP flowdular_metrics_dropped_samples_total Samples refused because the label set ceiling was reached.',
			'# TYPE flowdular_metrics_dropped_samples_total counter',
			`flowdular_metrics_dropped_samples_total ${dropped}`,
			'# HELP flowdular_process_start_time_seconds Process start time in seconds since the unix epoch.',
			'# TYPE flowdular_process_start_time_seconds gauge',
			`flowdular_process_start_time_seconds ${startTimeSeconds}`,
		);
		const resident = residentMemoryBytes();
		if (resident !== null) {
			lines.push(
				'# HELP process_resident_memory_bytes Resident set size of the process in bytes.',
				'# TYPE process_resident_memory_bytes gauge',
				`process_resident_memory_bytes ${resident}`,
			);
		}
		const lag = eventLoopLagSeconds();
		if (lag !== null) {
			lines.push(
				'# HELP nodejs_eventloop_lag_seconds Mean event loop delay in seconds since the previous scrape.',
				'# TYPE nodejs_eventloop_lag_seconds gauge',
				`nodejs_eventloop_lag_seconds ${lag}`,
			);
		}
		if (version !== null) {
			lines.push(
				'# HELP flowdular_build_info Version of the running platform build.',
				'# TYPE flowdular_build_info gauge',
				`flowdular_build_info{version="${version}"} 1`,
			);
		}
		return `${lines.join('\n')}\n`;
	};

	return Object.freeze({
		recordHttpRequest,
		setBuildVersion: (value: string) => {
			version = labelValue(value);
		},
		expose,
	});
}

let processMetrics: MetricsRegistry | undefined;

/**
 * The metrics of this process. Recording is always on and bounded; exposing it
 * is the platform's decision. Tests and libraries that need their own series
 * call `createMetricsRegistry` instead.
 */
export function serverMetrics(): MetricsRegistry {
	return (processMetrics ??= createMetricsRegistry());
}
