/**
 * Tracing, as RFC 0004 H7 asked for it: one W3C trace context carried from the
 * request through the job runner and into provider and tool calls, spans in a
 * bounded in-process buffer, an optional OTLP exporter and an error sink
 * behind the logger.
 *
 * What the platform owns: the buffer, its bounds, the sampler and the two
 * egress paths. What a module owns: where it resumes a trace. A module that
 * enqueues work stores `currentTraceParent()` on its own row and hands that
 * value back as `traceparent` when it starts the span for the claimed item, so
 * a job carries the trace that enqueued it and a row without one is a new
 * root. Nothing in the job runner contract changes for that.
 */
export {
	currentTrace,
	currentTraceParent,
	formatTraceParent,
	parseTraceParent,
	runWithTrace,
} from './context.ts';
export type { TraceContext } from './context.ts';
export { createTracer, serverTracer, TRACE_LIMITS } from './tracer.ts';
export type {
	RecordedSpan,
	Span,
	SpanAttributes,
	SpanAttributeValue,
	SpanKind,
	SpanStatus,
	StartSpanOptions,
	Tracer,
	TracerOptions,
	TraceStats,
} from './tracer.ts';
export {
	createOtlpSpanExporter,
	traceConfigFromEnvironment,
} from './exporter.ts';
export type {
	OtlpSpanExporterOptions,
	SpanExporter,
	SpanExporterStats,
	TraceConfig,
	TraceExporterKind,
} from './exporter.ts';
export {
	createErrorSink,
	errorSinkConfigFromEnvironment,
	ERROR_SINK_LIMITS,
	NO_ERRORS,
	serverErrorSink,
} from './error-sink.ts';
export type {
	ErrorReport,
	ErrorSink,
	ErrorSinkConfig,
	ErrorSinkKind,
	ErrorSinkStats,
	WebhookErrorSinkOptions,
} from './error-sink.ts';
