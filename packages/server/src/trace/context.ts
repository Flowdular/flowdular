import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * The W3C trace context a request, a job item and a provider call all carry.
 * Identities only: a consumer that wants the work reads the owner's own tables
 * through the ids it already has, so a context pins no request and no row.
 */
export interface TraceContext {
	/** 32 lowercase hex characters, never all zero. */
	readonly traceId: string;
	/** 16 lowercase hex characters, never all zero. */
	readonly spanId: string;
	/** The W3C sampled flag, carried verbatim to everything downstream. */
	readonly sampled: boolean;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const HEX_PAIR = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
/* Version 00 is exactly 55 characters. A later version may append fields, so
   the upper bound below bounds the header, not the format. */
const TRACEPARENT_LENGTH = 55;
const TRACEPARENT_MAX_LENGTH = 256;
const SAMPLED_FLAG = 0x01;

export function newTraceId(): string {
	return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
	return randomBytes(8).toString('hex');
}

/**
 * Parses a `traceparent` header value. Null means there is no usable context,
 * which is a new root and never an error: a header is written by whatever is
 * upstream, so a malformed one must not cost the request.
 */
export function parseTraceParent(
	value: string | null | undefined,
): TraceContext | null {
	if (
		typeof value !== 'string' ||
		value.length < TRACEPARENT_LENGTH ||
		value.length > TRACEPARENT_MAX_LENGTH
	) {
		return null;
	}
	const parts = value.split('-');
	if (parts.length < 4) return null;
	const [version, traceId, spanId, flags] = parts as [
		string,
		string,
		string,
		string,
	];
	/* `ff` is reserved as invalid; a version this code does not know still
	   carries its first four fields in the 00 layout, so it is read and the
	   rest ignored. Version 00 itself admits no extra field. */
	if (!HEX_PAIR.test(version) || version === 'ff') return null;
	if (version === '00' && parts.length !== 4) return null;
	if (!TRACE_ID.test(traceId) || traceId === ZERO_TRACE_ID) return null;
	if (!SPAN_ID.test(spanId) || spanId === ZERO_SPAN_ID) return null;
	if (!HEX_PAIR.test(flags)) return null;
	return {
		traceId,
		spanId,
		sampled: (Number.parseInt(flags, 16) & SAMPLED_FLAG) === SAMPLED_FLAG,
	};
}

/** Always emits version 00, which every reader of a later version accepts. */
export function formatTraceParent(context: TraceContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

const store = new AsyncLocalStorage<TraceContext>();

/** The trace the running code belongs to, absent outside a traced scope. */
export function currentTrace(): TraceContext | undefined {
	return store.getStore();
}

/**
 * The ambient trace as a header value, for a module that stores it on a row it
 * enqueues. Null outside a traced scope, which the claim reads as a new root.
 */
export function currentTraceParent(): string | null {
	const context = store.getStore();
	return context ? formatTraceParent(context) : null;
}

/**
 * Runs `work` with `context` as the ambient trace, including across every
 * await inside it. Everything that starts a span without naming a parent, and
 * every logged line, picks the context up from here.
 */
export function runWithTrace<T>(context: TraceContext, work: () => T): T {
	return store.run(context, work);
}
