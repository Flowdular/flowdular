import {
	createOtlpSpanExporter,
	errorSinkConfigFromEnvironment,
	serverErrorSink,
	traceConfigFromEnvironment,
	type ErrorSink,
	type SpanExporter,
} from '@flowdular/sdk/server';
import { platformVersion } from './metrics.ts';

export interface PlatformObservabilityOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly version?: string;
}

/* Batches one disposal drains from the error sink: the queue bound divided by
   the batch, and one over, because a report may be queued while it drains. */
const SINK_FLUSHES = 4;

/**
 * Sends what the error sink still holds. One flush sends one batch and the
 * queue holds more than one, so a single flush on the way out would strand the
 * rest. The loop ends on an empty queue, on a flush that moved nothing, or on
 * the bound, so an unreachable webhook can never hold a shutdown open.
 */
export async function drainErrorSink(sink: ErrorSink): Promise<void> {
	for (let batch = 0; batch < SINK_FLUSHES; batch += 1) {
		const queued = sink.stats().queued;
		if (queued === 0) return;
		await sink.flush();
		if (sink.stats().queued >= queued) return;
	}
}

export interface PlatformObservability {
	/** Null when `FD_TRACE_EXPORTER` is none, which is the default. */
	readonly exporter: SpanExporter | null;
	/** The sink logged errors are reported through; `none` holds nothing. */
	readonly errorSink: ErrorSink;
	/** Drains both egresses. Safe to call more than once. */
	dispose(): Promise<void>;
}

/**
 * Composes the two optional observability egresses for this deployment.
 *
 * Both configurations are read here, at boot, so a deployment that misspelled
 * a variable fails to start rather than quietly sending nothing. Spans are
 * always recorded into the bounded in-process buffer; only the export is
 * optional, and neither egress ever runs on a request path.
 *
 * The error sink is the process singleton the logger already reports through,
 * so this only validates it and drains it on shutdown: a process that stops
 * must not orphan the reports it queued.
 */
export function createPlatformObservability(
	options: PlatformObservabilityOptions = {},
): PlatformObservability {
	const environment = options.environment ?? process.env;
	const trace = traceConfigFromEnvironment(environment);
	/* Validated here and discarded: `serverErrorSink()` builds the live one from
	   the same variables, and a second sink would double every report. */
	errorSinkConfigFromEnvironment(environment);
	const errorSink = serverErrorSink();
	const exporter =
		trace.exporter === 'otlp' && trace.url
			? createOtlpSpanExporter({
					url: trace.url,
					headers: trace.headers,
					environment,
					serviceName: 'flowdular',
					serviceVersion: options.version ?? platformVersion(),
				})
			: null;
	return {
		exporter,
		errorSink,
		async dispose(): Promise<void> {
			/* Disposal drains the span buffer, so what this process recorded while
			   it stopped is still evidence about the stop. */
			await exporter?.dispose();
			await drainErrorSink(errorSink);
		},
	};
}
