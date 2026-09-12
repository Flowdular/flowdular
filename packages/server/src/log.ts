export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'text';

export interface LogFields {
	readonly [key: string]: unknown;
}

export interface LogEvent {
	/** Correlates a line with the response that carries the same id. */
	readonly requestId?: string;
	readonly endpoint?: string;
	readonly module?: string;
	readonly err?: unknown;
	/** Free-form context. Credential-shaped keys are redacted before writing. */
	readonly fields?: LogFields;
}

export interface Logger {
	readonly level: LogLevel;
	readonly format: LogFormat;
	debug(message: string, event?: LogEvent): void;
	info(message: string, event?: LogEvent): void;
	warn(message: string, event?: LogEvent): void;
	error(message: string, event?: LogEvent): void;
}

export interface LoggerOptions {
	/** Defaults to `FD_LOG_FORMAT`, else json in production and text elsewhere. */
	readonly format?: LogFormat;
	/** Defaults to `FD_LOG_LEVEL`, else info. */
	readonly level?: LogLevel;
	readonly environment?: NodeJS.ProcessEnv;
	/** Defaults to the console: warn and error on stderr, the rest on stdout. */
	readonly write?: (level: LogLevel, line: string) => void;
	readonly now?: () => Date;
}

const LEVELS: Readonly<Record<LogLevel, number>> = Object.freeze({
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
});

/* Over-approximates on purpose: a field that merely looks like a credential is
   worth losing, a credential that reaches a log file is not. */
const SENSITIVE_KEY =
	/authorization|cookie|password|token|secret|credential|api[-_]?key|session/i;
const REDACTED = '[redacted]';
const TRUNCATED = '[truncated]';
/* A log line is a diagnostic, not a transport. Depth, breadth and string length
   are bounded so one hostile or cyclic field cannot grow the process. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 32;
const MAX_STRING = 2_048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/g;

interface LoggedError {
	readonly name: string;
	readonly message?: string;
	readonly stack?: string;
}

function bounded(value: string): string {
	return value.length <= MAX_STRING
		? value
		: `${value.slice(0, MAX_STRING)}${TRUNCATED}`;
}

/* A request id arrives from a header and a field from whatever produced it, so
   a control character in either would forge a second line in text format. A
   stack is exempt: its own newlines are what makes it readable. */
function boundedString(value: string): string {
	return bounded(value).replace(CONTROL_CHARACTER, ' ');
}

function sanitize(value: unknown, depth: number): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case 'string':
			return boundedString(value);
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'boolean':
			return value;
		case 'bigint':
			return value.toString();
		case 'undefined':
			return undefined;
		case 'function':
		case 'symbol':
			return '[unserializable]';
		default:
			break;
	}
	if (depth >= MAX_DEPTH) return TRUNCATED;
	if (value instanceof Error) {
		return { name: value.name, message: boundedString(value.message) };
	}
	if (Array.isArray(value)) {
		const items = value
			.slice(0, MAX_ENTRIES)
			.map((entry) => sanitize(entry, depth + 1));
		return value.length > MAX_ENTRIES ? [...items, TRUNCATED] : items;
	}
	const result: Record<string, unknown> = {};
	let remaining = MAX_ENTRIES;
	for (const [key, entry] of Object.entries(value as object)) {
		if (remaining === 0) {
			result['...'] = TRUNCATED;
			break;
		}
		remaining -= 1;
		result[key] = SENSITIVE_KEY.test(key)
			? REDACTED
			: sanitize(entry, depth + 1);
	}
	return result;
}

/**
 * Keeps only the shape a log reader needs. A caller that must not publish an
 * error message passes `{ name }` instead of the error itself.
 */
function loggedError(value: unknown, withStack: boolean): LoggedError {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: boundedString(value.message),
			...(withStack && value.stack ? { stack: bounded(value.stack) } : {}),
		};
	}
	if (typeof value === 'object' && value !== null) {
		const record = value as { name?: unknown; message?: unknown };
		return {
			name: typeof record.name === 'string' ? record.name : 'non-error',
			...(typeof record.message === 'string'
				? { message: boundedString(record.message) }
				: {}),
		};
	}
	return { name: 'non-error' };
}

function textLine(record: Record<string, unknown>): string {
	const { time, level, msg, err, ...rest } = record as {
		time: string;
		level: string;
		msg: string;
		err?: LoggedError;
	} & Record<string, unknown>;
	const parts = [`${time} ${level.toUpperCase()} ${msg}`];
	for (const [key, value] of Object.entries(rest)) {
		parts.push(
			`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
		);
	}
	if (err) {
		parts.push(`err=${err.message ? `${err.name}: ${err.message}` : err.name}`);
	}
	return err?.stack ? `${parts.join(' ')}\n${err.stack}` : parts.join(' ');
}

function parseFormat(value: string | undefined): LogFormat | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === 'json' || normalized === 'text'
		? normalized
		: undefined;
}

function parseLevel(value: string | undefined): LogLevel | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized && normalized in LEVELS
		? (normalized as LogLevel)
		: undefined;
}

export function createLogger(options: LoggerOptions = {}): Logger {
	const environment = options.environment ?? process.env;
	const production = environment.NODE_ENV === 'production';
	const configuredFormat = parseFormat(environment.FD_LOG_FORMAT);
	const configuredLevel = parseLevel(environment.FD_LOG_LEVEL);
	const format =
		options.format ?? configuredFormat ?? (production ? 'json' : 'text');
	const level = options.level ?? configuredLevel ?? 'info';
	const threshold = LEVELS[level];
	const now = options.now ?? (() => new Date());
	const write =
		options.write ??
		((entryLevel: LogLevel, line: string) => {
			if (entryLevel === 'warn' || entryLevel === 'error') console.error(line);
			else console.log(line);
		});
	/* A stack can carry file paths and inlined values, so production publishes
	   one only when the operator asked for debug output. */
	const withStack = !production || level === 'debug';

	const emit = (
		entryLevel: LogLevel,
		message: string,
		event: LogEvent | undefined,
	) => {
		if (LEVELS[entryLevel] < threshold) return;
		const record: Record<string, unknown> = {
			time: now().toISOString(),
			level: entryLevel,
			msg: boundedString(message),
		};
		if (event?.requestId) record.requestId = boundedString(event.requestId);
		if (event?.endpoint) record.endpoint = boundedString(event.endpoint);
		if (event?.module) record.module = boundedString(event.module);
		if (event?.fields) record.fields = sanitize(event.fields, 0);
		if (event?.err !== undefined) {
			record.err = loggedError(event.err, withStack);
		}
		write(
			entryLevel,
			format === 'json' ? JSON.stringify(record) : textLine(record),
		);
	};

	const logger: Logger = {
		level,
		format,
		debug: (message, event) => emit('debug', message, event),
		info: (message, event) => emit('info', message, event),
		warn: (message, event) => emit('warn', message, event),
		error: (message, event) => emit('error', message, event),
	};
	if (environment.FD_LOG_FORMAT?.trim() && !configuredFormat) {
		logger.warn('FD_LOG_FORMAT is not "json" or "text"; using the default', {
			fields: { format },
		});
	}
	if (environment.FD_LOG_LEVEL?.trim() && !configuredLevel) {
		logger.warn(
			'FD_LOG_LEVEL is not "debug", "info", "warn" or "error"; using the default',
			{ fields: { level } },
		);
	}
	return logger;
}

let processLogger: Logger | undefined;

/**
 * The logger of this process, built from the environment on first use so a
 * deployment's `.env` is already loaded. Tests and libraries that need their
 * own sink call `createLogger` instead.
 */
export function serverLogger(): Logger {
	return (processLogger ??= createLogger());
}
