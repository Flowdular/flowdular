import { assertTraceEndpoint } from './egress.ts';

export type ErrorSinkKind = 'none' | 'webhook';

/**
 * What leaves the process when an error is logged. Identities, not payloads:
 * no stack, no log fields, no request body, so a report can never carry a
 * credential the logger already refuses to write.
 */
export interface ErrorReport {
	/** Epoch milliseconds. */
	readonly at: number;
	readonly name: string;
	readonly message?: string;
	readonly endpoint?: string;
	readonly module?: string;
	readonly requestId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
}

export interface ErrorSinkStats {
	readonly queued: number;
	readonly delivered: number;
	/** Reports refused because the queue was full, plus batches given up on. */
	readonly dropped: number;
	readonly failures: number;
}

export interface ErrorSink {
	readonly kind: ErrorSinkKind;
	/** Accepts a report and returns. Delivery never runs on the caller's path. */
	report(report: ErrorReport): void;
	/** Sends what is queued now. Never throws. */
	flush(): Promise<void>;
	stats(): ErrorSinkStats;
	dispose(): Promise<void>;
}

export interface ErrorSinkConfig {
	readonly kind: ErrorSinkKind;
	/** Absolute webhook URL, null when the sink is none. */
	readonly url: string | null;
	/** Bearer credential, null when the deployment configured none. */
	readonly token: string | null;
}

export interface WebhookErrorSinkOptions {
	readonly url: string;
	readonly token?: string | null;
	/** Defaults to `process.env`; production refuses a non-https endpoint. */
	readonly environment?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
	readonly flushEveryMs?: number;
}

/**
 * Every bound the error sink enforces. A report is a notification, not a
 * transport: a deployment whose webhook is down loses reports, never memory.
 */
export const ERROR_SINK_LIMITS = Object.freeze({
	/** Reports held before a new one is refused. */
	queue: 64,
	/** Reports one request carries. */
	batch: 32,
	/** Characters kept of a message. */
	messageChars: 512,
	/** Characters kept of a name, an endpoint, a module or an id. */
	fieldChars: 128,
	/** Bytes the serialized body may reach before the batch is halved. */
	bodyBytes: 8_192,
	/** Milliseconds between batches. */
	flushEveryMs: 5_000,
});

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/g;

function field(value: string | undefined, max: number): string | undefined {
	if (value === undefined) return undefined;
	const cut = (value.length <= max ? value : value.slice(0, max)).replace(
		CONTROL_CHARACTER,
		' ',
	);
	return cut.length === 0 ? undefined : cut;
}

function bounded(report: ErrorReport): ErrorReport {
	const { fieldChars, messageChars } = ERROR_SINK_LIMITS;
	return {
		at: Number.isFinite(report.at) ? report.at : 0,
		name: field(report.name, fieldChars) ?? 'non-error',
		...optional('message', field(report.message, messageChars)),
		...optional('endpoint', field(report.endpoint, fieldChars)),
		...optional('module', field(report.module, fieldChars)),
		...optional('requestId', field(report.requestId, fieldChars)),
		...optional('traceId', field(report.traceId, fieldChars)),
		...optional('spanId', field(report.spanId, fieldChars)),
	};
}

function optional(
	key: string,
	value: string | undefined,
): Record<string, string> {
	return value === undefined ? {} : { [key]: value };
}

/** The sink a deployment that configured none composes. It holds nothing. */
export const NO_ERRORS: ErrorSink = Object.freeze({
	kind: 'none' as const,
	report: () => undefined,
	flush: () => Promise.resolve(),
	stats: () => ({ queued: 0, delivered: 0, dropped: 0, failures: 0 }),
	dispose: () => Promise.resolve(),
});

/**
 * Posts logged errors to one webhook as bounded JSON, on its own cadence.
 * The queue drops the newest report when it is full, because the first report
 * of an incident is the one worth keeping and a flood is the same incident.
 */
function createWebhookErrorSink(options: WebhookErrorSinkOptions): ErrorSink {
	const environment = options.environment ?? process.env;
	assertTraceEndpoint(options.url, environment, 'FD_ERROR_SINK_URL');
	const send = options.fetch ?? fetch;
	const token = options.token?.trim() || null;
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
	const queue: ErrorReport[] = [];
	let delivered = 0;
	let dropped = 0;
	let failures = 0;
	let attempts = 0;
	let inFlight: Promise<void> | undefined;
	let disposed = false;

	/* Serialized once and halved until it fits, so a batch of maximal reports
	   cannot exceed the body bound however long the bounded fields are. */
	const body = (batch: ErrorReport[]): string => {
		let size = batch.length;
		for (;;) {
			const payload = JSON.stringify({ reports: batch.slice(0, size) });
			if (
				size === 1 ||
				Buffer.byteLength(payload) <= ERROR_SINK_LIMITS.bodyBytes
			)
				return payload;
			size = Math.max(1, Math.floor(size / 2));
		}
	};

	const drive = async (): Promise<void> => {
		if (queue.length === 0) return;
		const batch = queue.splice(0, ERROR_SINK_LIMITS.batch);
		let accepted = false;
		let retryable = true;
		try {
			const response = await send(options.url, {
				method: 'POST',
				headers,
				body: body(batch),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			accepted = response.ok;
			retryable = response.status === 429 || response.status >= 500;
		} catch {
			accepted = false;
		}
		if (accepted) {
			delivered += batch.length;
			attempts = 0;
			return;
		}
		failures += 1;
		attempts += 1;
		if (retryable && attempts < MAX_ATTEMPTS && !disposed) {
			/* Back at the head, and only as far as the queue bound allows. */
			const room = ERROR_SINK_LIMITS.queue - queue.length;
			queue.unshift(...batch.slice(0, room));
			dropped += Math.max(0, batch.length - room);
			return;
		}
		attempts = 0;
		dropped += batch.length;
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
		Math.max(
			1,
			Math.trunc(options.flushEveryMs ?? ERROR_SINK_LIMITS.flushEveryMs),
		),
	);
	timer.unref?.();

	return Object.freeze({
		kind: 'webhook' as const,
		report(report: ErrorReport): void {
			if (disposed) return;
			if (queue.length >= ERROR_SINK_LIMITS.queue) {
				dropped += 1;
				return;
			}
			queue.push(bounded(report));
			if (queue.length >= ERROR_SINK_LIMITS.batch) void flush();
		},
		flush,
		stats: (): ErrorSinkStats => ({
			queued: queue.length,
			delivered,
			dropped,
			failures,
		}),
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			await inFlight?.catch(() => undefined);
		},
	});
}

/**
 * The error reporting configuration of a deployment, refused at boot rather
 * than at the first failure. `otlp-logs` is deliberately not built: the OTLP
 * surface this platform speaks is the trace exporter above.
 */
export function errorSinkConfigFromEnvironment(
	environment: NodeJS.ProcessEnv,
): ErrorSinkConfig {
	const kind = environment.FD_ERROR_SINK?.trim() || 'none';
	if (kind !== 'none' && kind !== 'webhook') {
		throw new Error('FD_ERROR_SINK must be none or webhook.');
	}
	if (kind === 'none') return { kind: 'none', url: null, token: null };
	const url = environment.FD_ERROR_SINK_URL?.trim();
	if (!url) {
		throw new Error(
			'FD_ERROR_SINK_URL is required when FD_ERROR_SINK=webhook.',
		);
	}
	assertTraceEndpoint(url, environment, 'FD_ERROR_SINK_URL');
	return {
		kind: 'webhook',
		url,
		token: environment.FD_ERROR_SINK_TOKEN?.trim() || null,
	};
}

export function createErrorSink(
	config: ErrorSinkConfig,
	options: Omit<WebhookErrorSinkOptions, 'url' | 'token'> = {},
): ErrorSink {
	if (config.kind === 'none' || !config.url) return NO_ERRORS;
	return createWebhookErrorSink({
		...options,
		url: config.url,
		token: config.token,
	});
}

let processErrorSink: ErrorSink | undefined;

/**
 * The error sink of this process, built from the environment on first use.
 * `serverLogger()` reports every error line through it, so a module composes
 * nothing and a deployment that configured none pays no queue and no timer.
 */
export function serverErrorSink(): ErrorSink {
	if (processErrorSink) return processErrorSink;
	let config: ErrorSinkConfig = { kind: 'none', url: null, token: null };
	try {
		config = errorSinkConfigFromEnvironment(process.env);
	} catch {
		/* The platform refuses this while it composes. A process that never
		   composed one reports nothing rather than failing the line that is
		   already reporting a failure; logging here would recurse. */
	}
	processErrorSink = createErrorSink(config);
	return processErrorSink;
}
