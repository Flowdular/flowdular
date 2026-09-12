/* The two observability egresses, the trace exporter and the error sink, are
   both a URL and a header list an operator names in the environment. Their
   validation lives here so neither imports the other, and so a logger that
   reports through a sink never pulls the tracer in behind it. */

const MAX_HEADERS = 16;
const MAX_HEADER_VALUE = 1_024;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/* Printable ASCII: a control character in a configured header value would
   forge a second header on the wire. */
const HEADER_VALUE = /^[ -~]+$/;

/**
 * An observability endpoint has to be https wherever the deployment is real:
 * the payload carries endpoint ids, job names and failure timings for the
 * whole workspace.
 */
export function assertTraceEndpoint(
	url: string,
	environment: NodeJS.ProcessEnv,
	variable: string,
): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${variable} must be an absolute URL.`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`${variable} must be an http or https URL.`);
	}
	if (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
		throw new Error(`${variable} must be https in production.`);
	}
	return parsed;
}

/** `name=value,name2=value2`. Bounded in count, in name shape and in length. */
export function parseHeaderList(
	raw: string | undefined,
	variable: string,
): Readonly<Record<string, string>> {
	const trimmed = raw?.trim();
	if (!trimmed) return Object.freeze({});
	const headers: Record<string, string> = {};
	let count = 0;
	for (const entry of trimmed.split(',')) {
		const separator = entry.indexOf('=');
		if (separator <= 0)
			throw new Error(`${variable} must be name=value pairs.`);
		const name = entry.slice(0, separator).trim();
		const value = entry.slice(separator + 1).trim();
		if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
			throw new Error(`${variable} carries an unusable header name or value.`);
		}
		if (value.length > MAX_HEADER_VALUE) {
			throw new Error(`${variable} carries a header value over the bound.`);
		}
		count += 1;
		if (count > MAX_HEADERS) {
			throw new Error(`${variable} declares more than ${MAX_HEADERS} headers.`);
		}
		headers[name] = value;
	}
	return Object.freeze(headers);
}
