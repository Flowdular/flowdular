import { createHash, randomBytes } from 'node:crypto';
import type { ResearchResult } from '../domain/capability.ts';
import { RESEARCH_LIMITS } from '../domain/types.ts';

export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** At most `limit` bytes of UTF-8, never splitting a character. */
export function utf8Prefix(text: string, limit: number): string {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.byteLength <= limit) return text;
	let end = limit;
	/* A continuation byte is 10xxxxxx; step back to the start of its character. */
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString('utf8');
}

/** Control characters become spaces, so a stored title is one printable line. */
export function printable(value: string): string {
	let out = '';
	for (const char of value) {
		const code = char.codePointAt(0)!;
		out += code < 32 || code === 127 ? ' ' : char;
	}
	return out.replace(/ {2,}/g, ' ').trim();
}

function clean(value: unknown, maximum: number): string {
	return typeof value === 'string' ? printable(value).slice(0, maximum) : '';
}

/**
 * Adapter output is foreign data. An entry without an https or http URL is
 * dropped; text fields are cut to their bounds; the source defaults to the
 * host name.
 */
export function boundResults(entries: unknown): readonly ResearchResult[] {
	const list = Array.isArray(entries) ? entries : [];
	const accepted: ResearchResult[] = [];
	for (const entry of list) {
		const value = (entry ?? {}) as Record<string, unknown>;
		const raw = typeof value.url === 'string' ? value.url.trim() : '';
		if (raw.length === 0 || raw.length > RESEARCH_LIMITS.url) continue;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			continue;
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
		url.hash = '';
		/* Percent-encoding can multiply the length the raw text had. */
		if (url.toString().length > RESEARCH_LIMITS.url) continue;
		const publishedAt = clean(value.publishedAt, 64);
		accepted.push({
			url: url.toString(),
			title: clean(value.title, RESEARCH_LIMITS.title),
			snippet: clean(value.snippet, RESEARCH_LIMITS.snippet),
			source: clean(value.source, 200) || url.hostname,
			...(publishedAt ? { publishedAt } : {}),
		});
	}
	return accepted;
}

/**
 * Time-ordered identifiers in the UUID version 7 layout. Ids minted in one
 * process sort in the order they were minted, which is the order a query's
 * results are read back in; the counter carries that order inside one
 * millisecond.
 */
export function createIdGenerator(now: () => number = Date.now) {
	let lastMs = -1;
	let counter = 0;
	return (): string => {
		let ms = now();
		if (ms <= lastMs) {
			ms = lastMs;
			counter += 1;
			if (counter > 0xfff) {
				lastMs += 1;
				ms = lastMs;
				counter = 0;
			}
		} else {
			lastMs = ms;
			counter = 0;
		}
		const bytes = randomBytes(16);
		const time = BigInt(ms);
		for (let index = 0; index < 6; index += 1) {
			bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
		}
		bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
		bytes[7] = counter & 0xff;
		bytes[8] = 0x80 | (bytes[8]! & 0x3f);
		const hex = bytes.toString('hex');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};
}

/** A cell a spreadsheet would read as a formula is written as text. */
export function neutralCell(value: string): string {
	return /^[=+@-]/.test(value) || value.startsWith('\t') ? `'${value}` : value;
}
