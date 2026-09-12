import {
	serverTracer,
	TRACE_LIMITS,
	traceSampleRatio,
	type RecordedSpan,
	type SpanAttributeValue,
	type SpanKind,
	type Tracer,
} from './tracer.ts';
import { assertTraceEndpoint, parseHeaderList } from './egress.ts';

export type TraceExporterKind = 'none' | 'otlp';

export interface TraceConfig {
	readonly exporter: TraceExporterKind;
	/** Absolute OTLP traces endpoint, null when the exporter is none. */
	readonly url: string | null;
	readonly headers: Readonly<Record<string, string>>;
	readonly sampleRatio: number;
}

export interface SpanExporterStats {
	readonly exported: number;
	/** Spans a batch gave up on after the retry bound. */
	readonly dropped: number;
	readonly failures: number;
	readonly retries: number;
}

export interface SpanExporter {
	/** Sends what is buffered now. Never throws and never blocks a request. */
	flush(): Promise<void>;
	stats(): SpanExporterStats;
	/**
	 * Stops the timer, waits for the send in flight and drains what the buffer
	 * still holds, in bounded batches, so the spans of a stopping process still
	 * leave with it.
	 */
	dispose(): Promise<void>;
}

export interface OtlpSpanExporterOptions {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Defaults to the process tracer. */
	readonly tracer?: Tracer;
	readonly serviceName?: string;
	readonly serviceVersion?: string;
	/** Defaults to `process.env`; production refuses a non-https endpoint. */
	readonly environment?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
	/** Defaults to the trace limit. */
	readonly flushEveryMs?: number;
	readonly batchSpans?: number;
}

/* A batch that the collector could not take is retried on the next flush, not
   behind a sleep: the cadence is already the backoff, and a retry that blocks
   nothing cannot pile up. */
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
/* Batches one disposal drains. Sixteen default batches hold more than the
   default ring, so a stopping process sends everything it recorded; a ring
   configured larger than that keeps the bound, because a shutdown must end. */
const DISPOSE_BATCHES = 16;
const SPAN_KIND_CODE: Readonly<Record<SpanKind, number>> = Object.freeze({
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
});
const STATUS_CODE = Object.freeze({ unset: 0, ok: 1, error: 2 });

/* Nanoseconds exceed the safe integer range, so the value is built as a string
   through a bigint. Microsecond precision is what an epoch millisecond clock
   can honestly claim. */
function unixNano(milliseconds: number): string {
	return `${BigInt(Math.round(milliseconds * 1_000)) * 1_000n}`;
}

function attributeValue(value: SpanAttributeValue): Record<string, unknown> {
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'boolean') return { boolValue: value };
	return Number.isInteger(value)
		? { intValue: String(value) }
		: { doubleValue: value };
}

function attributes(
	entries: Readonly<Record<string, SpanAttributeValue>>,
): unknown[] {
	return Object.entries(entries).map(([key, value]) => ({
		key,
		value: attributeValue(value),
	}));
}

/** OTLP/HTTP JSON `ExportTraceServiceRequest`, built without an SDK. */
function otlpTracePayload(
	spans: readonly RecordedSpan[],
	service: { readonly name: string; readonly version: string },
): unknown {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: attributes({
						'service.name': service.name,
						'service.version': service.version,
					}),
				},
				scopeSpans: [
					{
						scope: { name: 'flowdular' },
						spans: spans.map((span) => ({
							traceId: span.traceId,
							spanId: span.spanId,
							...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
							name: span.name,
							kind: SPAN_KIND_CODE[span.kind],
							startTimeUnixNano: unixNano(span.startedAt),
							endTimeUnixNano: unixNano(span.endedAt),
							attributes: attributes(span.attributes),
							status: {
								code: STATUS_CODE[span.status],
								...(span.statusMessage ? { message: span.statusMessage } : {}),
							},
						})),
					},
				],
			},
		],
	};
}

/**
 * The tracing configuration of a deployment, refused at boot rather than at
 * the first request: a misconfigured exporter is an operator's mistake and
 * must never degrade into silently sending nothing.
 */
export function traceConfigFromEnvironment(
	environment: NodeJS.ProcessEnv,
): TraceConfig {
	const sampleRatio = traceSampleRatio(environment);
	const kind = environment.FD_TRACE_EXPORTER?.trim() || 'none';
	if (kind !== 'none' && kind !== 'otlp') {
		throw new Error('FD_TRACE_EXPORTER must be none or otlp.');
	}
	if (kind === 'none') {
		return { exporter: 'none', url: null, headers: {}, sampleRatio };
	}
	const url = environment.FD_TRACE_OTLP_URL?.trim();
	if (!url) {
		throw new Error(
			'FD_TRACE_OTLP_URL is required when FD_TRACE_EXPORTER=otlp.',
		);
	}
	assertTraceEndpoint(url, environment, 'FD_TRACE_OTLP_URL');
	return {
		exporter: 'otlp',
		url,
		headers: parseHeaderList(
			environment.FD_TRACE_OTLP_HEADERS,
			'FD_TRACE_OTLP_HEADERS',
		),
		sampleRatio,
	};
}

/**
 * Drains the process tracer into an OTLP collector over HTTP JSON, on its own
 * cadence. It never runs on a request path: a batch leaves on the timer or as
 * soon as the buffer holds a full batch, and a collector that is down costs
 * the process one bounded batch held for at most `MAX_ATTEMPTS` flushes.
 */
export function createOtlpSpanExporter(
	options: OtlpSpanExporterOptions,
): SpanExporter {
	const environment = options.environment ?? process.env;
	assertTraceEndpoint(options.url, environment, 'FD_TRACE_OTLP_URL');
	const tracer = options.tracer ?? serverTracer();
	const send = options.fetch ?? fetch;
	const batchSpans = Math.max(
		1,
		Math.trunc(options.batchSpans ?? TRACE_LIMITS.batchSpans),
	);
	const service = {
		name: options.serviceName ?? 'flowdular',
		version: options.serviceVersion ?? 'unknown',
	};
	const headers: Record<string, string> = {
		...options.headers,
		'content-type': 'application/json',
	};
	let exported = 0;
	let dropped = 0;
	let failures = 0;
	let retries = 0;
	let pending: { spans: readonly RecordedSpan[]; attempts: number } | undefined;
	let inFlight: Promise<void> | undefined;
	let disposed = false;

	const post = async (batch: {
		spans: readonly RecordedSpan[];
		attempts: number;
	}): Promise<void> => {
		let accepted = false;
		let retryable = true;
		try {
			const response = await send(options.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(otlpTracePayload(batch.spans, service)),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			accepted = response.ok;
			/* A 4xx that is not a rate limit means the payload or the credential is
			   wrong, and sending it again would only lose the next batch too. */
			retryable = response.status === 429 || response.status >= 500;
		} catch {
			accepted = false;
		}
		if (accepted) {
			exported += batch.spans.length;
			return;
		}
		failures += 1;
		if (retryable && batch.attempts + 1 < MAX_ATTEMPTS && !disposed) {
			pending = { spans: batch.spans, attempts: batch.attempts + 1 };
			retries += 1;
			return;
		}
		dropped += batch.spans.length;
	};

	const drive = async (): Promise<void> => {
		/* A batch that failed goes first, so the retry bound is spent on it
		   instead of on whatever happened to arrive since. */
		const batch = pending ?? { spans: tracer.drain(batchSpans), attempts: 0 };
		pending = undefined;
		if (batch.spans.length === 0) return;
		await post(batch);
	};

	const flush = (): Promise<void> => {
		if (inFlight) return inFlight;
		const running = drive()
			.catch(() => undefined)
			.finally(() => {
				if (inFlight === running) inFlight = undefined;
			});
		inFlight = running;
		return running;
	};

	const timer = setInterval(
		() => void flush(),
		Math.max(1, Math.trunc(options.flushEveryMs ?? TRACE_LIMITS.flushEveryMs)),
	);
	/* An exporter is never the reason a process stays alive. */
	timer.unref?.();
	let scheduled: ReturnType<typeof setImmediate> | undefined;
	const detach = tracer.onSpanRecorded((buffered) => {
		if (disposed || scheduled || buffered < batchSpans) return;
		/* The span that filled the batch ended on a request's stack, and a send
		   starts synchronously. The full batch leaves on the next turn instead,
		   so no request ever waits on the collector. */
		scheduled = setImmediate(() => {
			scheduled = undefined;
			void flush();
		});
		scheduled.unref?.();
	});

	return Object.freeze({
		flush,
		stats: (): SpanExporterStats => ({ exported, dropped, failures, retries }),
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			if (scheduled) clearImmediate(scheduled);
			detach();
			await inFlight?.catch(() => undefined);
			/* A retry is refused past `disposed`, so each batch either leaves or is
			   dropped and the loop ends on an empty buffer or on the bound: a
			   collector that is down cannot hold a shutdown. */
			for (let batch = 0; batch < DISPOSE_BATCHES; batch += 1) {
				if (!pending && tracer.stats().buffered === 0) return;
				await flush();
			}
		},
	});
}
