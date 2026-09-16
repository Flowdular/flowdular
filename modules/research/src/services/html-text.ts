/*
 * A small readability pass over HTML: the title, the article or main element
 * when a page has one with enough text, block structure as line breaks, and
 * nothing of scripts, styles, navigation, page chrome or comments. It scans
 * forward with indexOf only, so a hostile page costs one pass over its bytes.
 */

const DROPPED = new Set([
	'script',
	'style',
	'noscript',
	'template',
	'svg',
	'math',
	'iframe',
	'object',
	'canvas',
	'head',
	'nav',
	'header',
	'footer',
	'aside',
	'form',
	'select',
	'button',
]);

const BLOCKS = new Set([
	'address',
	'article',
	'blockquote',
	'br',
	'dd',
	'div',
	'dl',
	'dt',
	'figcaption',
	'figure',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'li',
	'main',
	'ol',
	'p',
	'pre',
	'section',
	'table',
	'td',
	'th',
	'tr',
	'ul',
]);

const NAMED_ENTITIES: Readonly<Record<string, number>> = {
	amp: 38,
	lt: 60,
	gt: 62,
	quot: 34,
	apos: 39,
	nbsp: 160,
	copy: 169,
	reg: 174,
	trade: 8482,
	hellip: 8230,
	mdash: 8212,
	ndash: 8211,
	lsquo: 8216,
	rsquo: 8217,
	ldquo: 8220,
	rdquo: 8221,
	laquo: 171,
	raquo: 187,
	bull: 8226,
	middot: 183,
	euro: 8364,
	pound: 163,
	yen: 165,
	cent: 162,
	sect: 167,
	deg: 176,
	times: 215,
	divide: 247,
	shy: 173,
};

/** Only ASCII letters change, so every index into the result is an index into the input. */
function asciiLower(value: string): string {
	return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

export function decodeEntities(value: string): string {
	return value.replace(
		/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
		(entity, body: string) => {
			let code: number | undefined;
			if (body.startsWith('#x') || body.startsWith('#X')) {
				code = Number.parseInt(body.slice(2), 16);
			} else if (body.startsWith('#')) {
				code = Number.parseInt(body.slice(1), 10);
			} else {
				code = NAMED_ENTITIES[body.toLowerCase()];
			}
			if (code === undefined) return entity;
			if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
				return String.fromCodePoint(0xfffd);
			}
			return String.fromCodePoint(code);
		},
	);
}

function normalize(text: string): string {
	const lines = text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.replace(/[\t\f\v \u00a0]+/g, ' ').trim());
	const kept: string[] = [];
	let blank = 0;
	for (const line of lines) {
		if (line === '') {
			blank += 1;
			if (blank === 1 && kept.length > 0) kept.push('');
			continue;
		}
		blank = 0;
		kept.push(line);
	}
	return kept.join('\n').trim();
}

/** The text of `html[start, end)`, element by element. */
function textOf(
	html: string,
	lower: string,
	start: number,
	end: number,
): string {
	const parts: string[] = [];
	let index = start;
	while (index < end) {
		const open = lower.indexOf('<', index);
		if (open < 0 || open >= end) {
			parts.push(decodeEntities(html.slice(index, end)));
			break;
		}
		if (open > index) parts.push(decodeEntities(html.slice(index, open)));
		if (lower.startsWith('<!--', open)) {
			const close = lower.indexOf('-->', open + 4);
			index = close < 0 ? end : close + 3;
			continue;
		}
		let cursor = open + 1;
		const closing = lower[cursor] === '/';
		if (closing) cursor += 1;
		let nameEnd = cursor;
		while (nameEnd < end && /[a-z0-9]/.test(lower[nameEnd]!)) nameEnd += 1;
		const name = lower.slice(cursor, nameEnd);
		if (
			name === '' &&
			!lower.startsWith('<!', open) &&
			!lower.startsWith('<?', open)
		) {
			parts.push('<');
			index = open + 1;
			continue;
		}
		const tagEnd = lower.indexOf('>', nameEnd);
		if (tagEnd < 0 || tagEnd >= end) break;
		index = tagEnd + 1;
		if (!closing && DROPPED.has(name) && lower[tagEnd - 1] !== '/') {
			const close = lower.indexOf('</' + name, index);
			const after = close < 0 ? -1 : lower.indexOf('>', close);
			index = after < 0 || after >= end ? end : after + 1;
			parts.push('\n');
			continue;
		}
		if (BLOCKS.has(name)) parts.push('\n');
	}
	return normalize(parts.join(''));
}

function region(
	lower: string,
	name: string,
): { readonly start: number; readonly end: number } | null {
	const open = lower.indexOf('<' + name);
	if (open < 0) return null;
	const next = lower[open + name.length + 1];
	if (next !== '>' && next !== ' ' && next !== '\n' && next !== '\t')
		return null;
	const start = lower.indexOf('>', open);
	const end = lower.lastIndexOf('</' + name);
	return start < 0 || end <= start ? null : { start: start + 1, end };
}

/** Below this many characters an article or main element is navigation, not content. */
const CONTENT_MINIMUM = 200;

export function htmlToText(html: string): {
	readonly title: string;
	readonly text: string;
} {
	const lower = asciiLower(html);
	let title = '';
	const titleOpen = lower.indexOf('<title');
	if (titleOpen >= 0) {
		const start = lower.indexOf('>', titleOpen);
		const end = start < 0 ? -1 : lower.indexOf('</title', start);
		if (start >= 0 && end > start) {
			title = normalize(decodeEntities(html.slice(start + 1, end))).replace(
				/\n+/g,
				' ',
			);
		}
	}
	let text = '';
	for (const name of ['article', 'main']) {
		const found = region(lower, name);
		if (!found) continue;
		const candidate = textOf(html, lower, found.start, found.end);
		if (candidate.length >= CONTENT_MINIMUM) {
			text = candidate;
			break;
		}
	}
	if (text === '') {
		const body = region(lower, 'body');
		text = body
			? textOf(html, lower, body.start, body.end)
			: textOf(html, lower, 0, html.length);
	}
	if (title === '') {
		const heading = region(lower, 'h1');
		if (heading) title = textOf(html, lower, heading.start, heading.end);
	}
	return { title: title.replace(/\s+/g, ' ').trim(), text };
}
