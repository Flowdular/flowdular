import { serverLogger } from '../log.ts';
import {
	currentTrace,
	newSpanId,
	newTraceId,
	parseTraceParent,
	type TraceContext,
} from './context.ts';

export type SpanKind =
	| 'internal'
	| 'server'
	| 'client'
	| 'producer'
	| 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';
export type SpanAttributeValue = string | number | boolean;

export interface SpanAttributes {
	readonly [key: string]: SpanAttributeValue;
}

/**
 * A unit of work with a name, a start, an end, a status and bounded
 * attributes. Ending it is idempotent, so a `finally` may always call it.
 */
export interface Span {
	readonly context: TraceContext;
	/** Ignored past the attribute ceiling and after the span ended. */
	setAttribute(key: string, value: SpanAttributeValue): void;
	/**
	 * `endedAt` is epoch milliseconds, for a consumer replaying an instant it
	 * was told about rather than one it observed, such as the job event sink.
	 * Absent reads the tracer's clock.
	 */
	end(status?: SpanStatus, message?: string, endedAt?: number): void;
}

export interface StartSpanOptions {
	/**
	 * Absent takes the ambient trace, so nested work nests without threading a
	 * context by hand. Null is an explicit new root.
	 */
	readonly parent?: TraceContext | null;
	/** Parsed when `parent` is absent; a header that does not parse is a root. */
	readonly traceparent?: string | null;
	readonly kind?: SpanKind;
	readonly attributes?: SpanAttributes;
	/** Epoch milliseconds. Defaults to the tracer's clock. */
	readonly startedAt?: number;
}

/** What a recorded span carries once it ended. Values only, no references. */
export interface RecordedSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId: string | null;
	readonly name: string;
	readonly kind: SpanKind;
	/** Epoch milliseconds. */
	readonly startedAt: number;
	readonly endedAt: number;
	readonly status: SpanStatus;
	readonly statusMessage: string | null;
	readonly attributes: SpanAttributes;
}

export interface TraceStats {
	/** Spans waiting to be drained. */
	readonly buffered: number;
	/** Spans the buffer evicted because it was full. */
	readonly dropped: number;
	/** Sampled spans recorded since the process started. */
	readonly recorded: number;
}

export interface Tracer {
	/** 0 to 1. A root outside that ratio still propagates, it is not recorded. */
	readonly sampleRatio: number;
	startSpan(name: string, options?: StartSpanOptions): Span;
	/** Up to `max` spans, oldest first, removed from the buffer. */
	drain(max?: number): readonly RecordedSpan[];
	stats(): TraceStats;
	/**
	 * One consumer at a time; the returned function detaches it. The listener
	 * is called with the buffered count after every recorded span, isolated.
	 */
	onSpanRecorded(listener: (buffered: number) => void): () => void;
}

/**
 * Every bound the in-process trace buffer enforces. A span is a diagnostic,
 * never a transport: attribute count, attribute length and buffered spans are
 * all capped so one hostile caller cannot grow the process.
 */
export const TRACE_LIMITS = Object.freeze({
	/** Spans held before the oldest is evicted. */
	bufferSpans: 4_096,
	/** Attributes kept per span. */
	attributes: 16,
	/** Characters kept per attribute key and per string value. */
	attributeChars: 256,
	/** Characters kept of a span name. */
	nameChars: 256,
	/** Spans one export batch carries. */
	batchSpans: 512,
	/** Milliseconds between export batches. */
	flushEveryMs: 5_000,
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/g;
const SAMPLE_DENOMINATOR = 0x1_0000_0000;

/* A span name and an attribute both reach an exporter and a log line, so a
   control character in either would forge a second record downstream. */
function boundedText(value: string, max: number): string {
	const cut = value.length <= max ? value : value.slice(0, max);
	return cut.replace(CONTROL_CHARACTER, ' ');
}

/* Deterministic on the trace id so the whole trace shares one decision, and so
   a test that injects ids gets a stable answer instead of a coin flip. */
function sampledByRatio(traceId: string, ratio: number): boolean {
	if (ratio >= 1) return true;
	if (ratio <= 0) return false;
	return Number.parseInt(traceId.slice(-8), 16) / SAMPLE_DENOMINATOR < ratio;
}

/* Propagated but never recorded. It still owns a span id, because a downstream
   service reads the header and must see a parent that exists. */
class UnsampledSpan implements Span {
	constructor(readonly context: TraceContext) {}
	setAttribute(): void {}
	end(): void {}
}

class RecordingSpan implements Span {
	#ended = false;
	#count = 0;
	readonly #attributes: Record<string, SpanAttributeValue> = {};

	constructor(
		readonly context: TraceContext,
		private readonly parentSpanId: string | null,
		private readonly name: string,
		private readonly kind: SpanKind,
		private readonly startedAt: number,
		private readonly now: () => number,
		private readonly record: (span: RecordedSpan) => void,
	) {}

	setAttribute(key: string, value: SpanAttributeValue): void {
		if (this.#ended) return;
		if (typeof value === 'number' && !Number.isFinite(value)) return;
		const name = boundedText(key, TRACE_LIMITS.attributeChars);
		if (name.length === 0) return;
		/* The ceiling bounds distinct keys, so overwriting one the span already
		   carries is always admitted: it grows nothing. */
		if (!(name in this.#attributes)) {
			if (this.#count >= TRACE_LIMITS.attributes) return;
			this.#count += 1;
		}
		this.#attributes[name] =
			typeof value === 'string'
				? boundedText(value, TRACE_LIMITS.attributeChars)
				: value;
	}

	end(status: SpanStatus = 'unset', message?: string, endedAt?: number): void {
		if (this.#ended) return;
		this.#ended = true;
		this.record({
			traceId: this.context.traceId,
			spanId: this.context.spanId,
			parentSpanId: this.parentSpanId,
			name: this.name,
			kind: this.kind,
			startedAt: this.startedAt,
			endedAt: endedAt ?? this.now(),
			status,
			statusMessage:
				message === undefined
					? null
					: boundedText(message, TRACE_LIMITS.attributeChars),
			attributes: this.#attributes,
		});
	}
}

export interface TracerOptions {
	/** 0 to 1. Anything outside that, or not a number, is 1. */
	readonly sampleRatio?: number;
	/** Epoch milliseconds. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Hex id source, for a test that needs a stable sampling decision. */
	readonly newTraceId?: () => string;
	readonly newSpanId?: () => string;
	/** Buffered spans before the oldest is evicted. Defaults to the limit. */
	readonly bufferSpans?: number;
}

/**
 * Collects spans into one bounded ring. It sends nothing and opens no handle:
 * an exporter drains it, and a deployment that composes none still pays only
 * the ring, which evicts its oldest span rather than growing.
 */
export function createTracer(options: TracerOptions = {}): Tracer {
	const ratio =
		typeof options.sampleRatio === 'number' &&
		Number.isFinite(options.sampleRatio) &&
		options.sampleRatio >= 0 &&
		options.sampleRatio <= 1
			? options.sampleRatio
			: 1;
	const now = options.now ?? (() => Date.now());
	const traceId = options.newTraceId ?? newTraceId;
	const spanId = options.newSpanId ?? newSpanId;
	const capacity = Math.max(
		1,
		Math.trunc(options.bufferSpans ?? TRACE_LIMITS.bufferSpans),
	);
	const ring = new Array<RecordedSpan | undefined>(capacity);
	let head = 0;
	let size = 0;
	let dropped = 0;
	let recorded = 0;
	let listener: ((buffered: number) => void) | undefined;

	const record = (span: RecordedSpan): void => {
		if (size === capacity) {
			/* Drop oldest: the newest span is the one a reader is waiting for, and
			   an exporter that fell behind must not decide what the process keeps. */
			ring[head] = span;
			head = (head + 1) % capacity;
			dropped += 1;
		} else {
			ring[(head + size) % capacity] = span;
			size += 1;
		}
		recorded += 1;
		if (!listener) return;
		try {
			listener(size);
		} catch {
			/* An observer that throws is the observer's defect, not the span's. */
		}
	};

	return Object.freeze({
		sampleRatio: ratio,
		startSpan(name: string, startOptions: StartSpanOptions = {}): Span {
			const parent =
				startOptions.parent !== undefined
					? startOptions.parent
					: startOptions.traceparent !== undefined
						? parseTraceParent(startOptions.traceparent)
						: (currentTrace() ?? null);
			const id = parent ? parent.traceId : traceId();
			const context: TraceContext = {
				traceId: id,
				spanId: spanId(),
				sampled: parent ? parent.sampled : sampledByRatio(id, ratio),
			};
			if (!context.sampled) return new UnsampledSpan(context);
			const span = new RecordingSpan(
				context,
				parent ? parent.spanId : null,
				boundedText(name, TRACE_LIMITS.nameChars),
				startOptions.kind ?? 'internal',
				startOptions.startedAt ?? now(),
				now,
				record,
			);
			if (startOptions.attributes) {
				for (const [key, value] of Object.entries(startOptions.attributes)) {
					span.setAttribute(key, value);
				}
			}
			return span;
		},
		drain(max = capacity): readonly RecordedSpan[] {
			const take = Math.min(size, Math.max(0, Math.trunc(max)));
			const batch = new Array<RecordedSpan>(take);
			for (let index = 0; index < take; index += 1) {
				batch[index] = ring[head]!;
				ring[head] = undefined;
				head = (head + 1) % capacity;
			}
			size -= take;
			return batch;
		},
		stats: (): TraceStats => ({ buffered: size, dropped, recorded }),
		onSpanRecorded(next: (buffered: number) => void): () => void {
			listener = next;
			return () => {
				if (listener === next) listener = undefined;
			};
		},
	});
}

/**
 * The sample ratio this process records at, from `FD_TRACE_SAMPLE`. Throws on
 * a value that is not a ratio, so a deployment that meant to sample never
 * silently records everything.
 */
export function traceSampleRatio(environment: NodeJS.ProcessEnv): number {
	const raw = environment.FD_TRACE_SAMPLE?.trim();
	if (!raw) return 1;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error('FD_TRACE_SAMPLE must be a ratio between 0 and 1.');
	}
	return value;
}

let processTracer: Tracer | undefined;

/**
 * The tracer of this process, built from the environment on first use so a
 * deployment's `.env` is already loaded. Recording is always on and bounded;
 * exporting is the platform's decision. Tests and libraries that need their
 * own buffer call `createTracer` instead.
 */
export function serverTracer(): Tracer {
	if (processTracer) return processTracer;
	let ratio = 1;
	try {
		ratio = traceSampleRatio(process.env);
	} catch {
		/* The platform refuses the value while it composes, so this arm is only
		   reached by a process that never composed one. It records everything and
		   says so, rather than failing a request over a diagnostic. */
		serverLogger().warn('FD_TRACE_SAMPLE is not a ratio; recording every span');
	}
	processTracer = createTracer({ sampleRatio: ratio });
	return processTracer;
}
