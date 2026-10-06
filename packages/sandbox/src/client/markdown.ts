/* The Markdown coding agents write in a chat, sized to that and no larger:
   headings, paragraphs, nested lists, fenced code, GFM tables, quotes and
   rules, with code spans, strong, emphasis, links and bare web addresses
   inline. It costs no dependency, as scripts/document-markdown.mjs does not.

   The result is a tree the transcript renders as elements, so nothing in a
   message reaches the page as markup: raw HTML stays text, and only http,
   https and mailto addresses become links. */

export type MarkdownInline =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'code'; readonly text: string }
	| { readonly kind: 'strong'; readonly children: readonly MarkdownInline[] }
	| { readonly kind: 'emphasis'; readonly children: readonly MarkdownInline[] }
	| {
			readonly kind: 'link';
			readonly href: string;
			readonly children: readonly MarkdownInline[];
	  };

export type TableAlign = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
	| { readonly kind: 'paragraph'; readonly inlines: readonly MarkdownInline[] }
	| {
			readonly kind: 'heading';
			readonly level: number;
			readonly inlines: readonly MarkdownInline[];
	  }
	| {
			readonly kind: 'list';
			readonly ordered: boolean;
			readonly start: number;
			readonly items: readonly (readonly MarkdownBlock[])[];
	  }
	| { readonly kind: 'code'; readonly language: string; readonly text: string }
	| { readonly kind: 'quote'; readonly blocks: readonly MarkdownBlock[] }
	| {
			readonly kind: 'table';
			readonly align: readonly TableAlign[];
			readonly head: readonly (readonly MarkdownInline[])[];
			readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
	  }
	| { readonly kind: 'rule' };

/* Nesting past these depths, and links and tables past these sizes, are read
   as plain text, so a hostile message costs a bounded amount of work and
   stack. */
const MAX_BLOCK_DEPTH = 8;
const MAX_INLINE_DEPTH = 8;
const LINK_LABEL_MAX = 1000;
const LINK_URL_MAX = 2048;
const MAX_TABLE_COLUMNS = 20;

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER_CELL = /^:?-+:?$/;
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const AUTOLINK = /https?:\/\//iy;
const ADDRESS_END = /[\s<>`]/;
const TRAILING_PUNCTUATION = /[.,:;!?'"*_~]/;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function parseMarkdown(text: string): MarkdownBlock[] {
	const lines = text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
	return parseBlocks(lines, 0);
}

/* Only an absolute address with an allowed protocol becomes a link. The URL
   parser strips the whitespace and control characters a `javascript:` address
   could hide behind, and a relative address has nothing to resolve against. */
export function safeHref(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

interface Fence {
	readonly indent: number;
	readonly marker: string;
	readonly language: string;
}

/* A backtick fence cannot carry a backtick after it, so "```a```" on one line
   stays an inline code span. */
function fenceAt(line: string): Fence | null {
	const match = FENCE.exec(line);
	if (!match || (match[2]![0] === '`' && match[3]!.includes('`'))) return null;
	return {
		indent: match[1]!.length,
		marker: match[2]!,
		language: match[3]!.trim().split(/\s+/)[0] ?? '',
	};
}

function startsBlock(line: string): boolean {
	return (
		fenceAt(line) !== null ||
		HEADING.test(line) ||
		RULE.test(line) ||
		QUOTE.test(line)
	);
}

function parseBlocks(lines: readonly string[], depth: number): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (!line.trim()) {
			index += 1;
			continue;
		}
		const fence = fenceAt(line);
		if (fence) {
			index = codeBlock(lines, index, fence, blocks);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({
				kind: 'heading',
				level: heading[1]!.length,
				inlines: parseInline(headingText(line.slice(heading[0].length))),
			});
			index += 1;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ kind: 'rule' });
			index += 1;
			continue;
		}
		if (depth < MAX_BLOCK_DEPTH && QUOTE.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length && QUOTE.test(lines[index]!)) {
				quoted.push(lines[index]!.replace(QUOTE, ''));
				index += 1;
			}
			blocks.push({ kind: 'quote', blocks: parseBlocks(quoted, depth + 1) });
			continue;
		}
		if (depth < MAX_BLOCK_DEPTH && ITEM.test(line)) {
			index = list(lines, index, depth, blocks);
			continue;
		}
		if (tableAt(lines, index)) {
			index = table(lines, index, blocks);
			continue;
		}
		index = paragraph(lines, index, depth, blocks);
	}
	return blocks;
}

/* The heading's text without its optional closing run of hashes. */
function headingText(rest: string): string {
	const text = rest.trim();
	let end = text.length;
	while (end > 0 && text[end - 1] === '#') end -= 1;
	if (end === 0) return '';
	return end < text.length && /[ \t]/.test(text[end - 1]!)
		? text.slice(0, end).trimEnd()
		: text;
}

function codeBlock(
	lines: readonly string[],
	start: number,
	fence: Fence,
	blocks: MarkdownBlock[],
): number {
	const { indent, marker } = fence;
	const body: string[] = [];
	let index = start + 1;
	while (index < lines.length) {
		const line = lines[index]!;
		const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
		index += 1;
		if (
			close &&
			close[1]![0] === marker[0] &&
			close[1]!.length >= marker.length
		)
			break;
		body.push(line.slice(Math.min(indent, indentOf(line))));
	}
	blocks.push({
		kind: 'code',
		language: fence.language,
		text: body.join('\n'),
	});
	return index;
}

function markerKind(marker: string): string {
	return /\d/.test(marker) ? 'ordered' + marker.slice(-1) : marker;
}

function list(
	lines: readonly string[],
	start: number,
	depth: number,
	blocks: MarkdownBlock[],
): number {
	const first = ITEM.exec(lines[start]!)!;
	const kind = markerKind(first[2]!);
	const ordered = kind.startsWith('ordered');
	const items: MarkdownBlock[][] = [];
	let index = start;
	while (index < lines.length) {
		let next = index;
		while (next < lines.length && !lines[next]!.trim()) next += 1;
		const match = next < lines.length ? ITEM.exec(lines[next]!) : null;
		if (!match || markerKind(match[2]!) !== kind || RULE.test(lines[next]!))
			break;
		const spacing = match[3]?.length ?? 1;
		const contentIndent =
			match[1]!.length + match[2]!.length + (spacing > 4 ? 1 : spacing);
		const body = [match[4] ?? ''];
		index = next + 1;
		while (index < lines.length) {
			const line = lines[index]!;
			if (!line.trim()) {
				let after = index + 1;
				while (after < lines.length && !lines[after]!.trim()) after += 1;
				if (after >= lines.length || indentOf(lines[after]!) < contentIndent)
					break;
				for (; index < after; index += 1) body.push('');
				continue;
			}
			if (indentOf(line) >= contentIndent) {
				body.push(line.slice(contentIndent));
				index += 1;
				continue;
			}
			if (ITEM.test(line) || startsBlock(line) || !body.at(-1)?.trim()) break;
			/* A lazy line continues the item's paragraph. */
			body.push(line.trimStart());
			index += 1;
		}
		items.push(parseBlocks(body, depth + 1));
	}
	blocks.push({
		kind: 'list',
		ordered,
		start: ordered ? Number.parseInt(first[2]!, 10) : 1,
		items,
	});
	return index;
}

function paragraph(
	lines: readonly string[],
	start: number,
	depth: number,
	blocks: MarkdownBlock[],
): number {
	const body = [lines[start]!.trim()];
	let index = start + 1;
	while (index < lines.length) {
		const line = lines[index]!;
		if (!line.trim() || startsBlock(line) || tableAt(lines, index)) break;
		/* A list interrupts a paragraph only with an item that has content, and
		   an ordered one only when it starts at 1, so a sentence that happens to
		   start with a year is not a list. */
		const item = depth < MAX_BLOCK_DEPTH ? ITEM.exec(line) : null;
		if (
			item?.[4]?.trim() &&
			(!/\d/.test(item[2]!) || Number.parseInt(item[2]!, 10) === 1)
		)
			break;
		body.push(line.trim());
		index += 1;
	}
	blocks.push({ kind: 'paragraph', inlines: parseInline(body.join('\n')) });
	return index;
}

function splitRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith('|')) text = text.slice(1);
	if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
	const cells: string[] = [];
	let cell = '';
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index]!;
		if (ch === '\\' && text[index + 1] === '|') {
			cell += '\\|';
			index += 1;
		} else if (ch === '|') {
			cells.push(cell.trim());
			cell = '';
		} else cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

function delimiterRow(line: string | undefined): TableAlign[] | null {
	if (line === undefined || !line.includes('|')) return null;
	const cells = splitRow(line);
	if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
	return cells.map((cell) =>
		cell.startsWith(':') && cell.endsWith(':')
			? 'center'
			: cell.endsWith(':')
				? 'right'
				: cell.startsWith(':')
					? 'left'
					: null,
	);
}

function tableAt(lines: readonly string[], index: number): boolean {
	const head = lines[index]!;
	if (!head.includes('|')) return false;
	const align = delimiterRow(lines[index + 1]);
	return (
		align !== null &&
		align.length <= MAX_TABLE_COLUMNS &&
		align.length === splitRow(head).length
	);
}

function table(
	lines: readonly string[],
	start: number,
	blocks: MarkdownBlock[],
): number {
	const head = splitRow(lines[start]!);
	const align = delimiterRow(lines[start + 1])!;
	const rows: MarkdownInline[][][] = [];
	let index = start + 2;
	while (index < lines.length) {
		const line = lines[index]!;
		if (!line.trim() || !line.includes('|') || startsBlock(line)) break;
		const cells = splitRow(line);
		rows.push(head.map((_, column) => parseInline(cells[column] ?? '')));
		index += 1;
	}
	blocks.push({
		kind: 'table',
		align,
		head: head.map((cell) => parseInline(cell)),
		rows,
	});
	return index;
}

interface InlineContext {
	readonly text: string;
	/* Where each code span ends, by the index its opening run starts at. */
	readonly spans: ReadonlyMap<number, number>;
	/* Set at every index inside a code span, so no other syntax closes there. */
	readonly code: Uint8Array;
	/* Where the bracket or parenthesis opened at an index closes, or -1. */
	readonly closers: Int32Array;
}

export function parseInline(text: string): MarkdownInline[] {
	const { spans, code } = codeSpans(text);
	const context = { text, spans, code, closers: closers(text, code) };
	return inlineNodes(context, 0, text.length, 0, false);
}

function runLength(text: string, index: number, ch: string): number {
	let end = index;
	while (text[end] === ch) end += 1;
	return end - index;
}

function codeSpans(text: string): Pick<InlineContext, 'spans' | 'code'> {
	const spans = new Map<number, number>();
	const code = new Uint8Array(text.length);
	/* Once no closing run of a length follows an index, none follows a later
	   index either, so each length is searched to the end at most once. */
	const exhausted = new Set<number>();
	let index = 0;
	while (index < text.length) {
		const ch = text[index];
		if (ch === '\\') {
			index += 2;
			continue;
		}
		if (ch !== '`') {
			index += 1;
			continue;
		}
		const run = runLength(text, index, '`');
		const close = exhausted.has(run) ? -1 : closingRun(text, index + run, run);
		if (close < 0) {
			exhausted.add(run);
			index += run;
			continue;
		}
		spans.set(index, close + run);
		code.fill(1, index, close + run);
		index = close + run;
	}
	return { spans, code };
}

/* Each bracket and parenthesis is matched once for the whole text, so trying a
   link at every bracket stays linear. A label passes over code and escaped
   characters; an address ends at whitespace or `<`. */
function closers(text: string, code: Uint8Array): Int32Array {
	const closes = new Int32Array(text.length).fill(-1);
	if (!text.includes('](')) return closes;
	const open: number[] = [];
	for (let at = 0; at < text.length; at += 1) {
		if (code[at]) continue;
		const ch = text[at];
		if (ch === '\\') at += 1;
		else if (ch === '[') open.push(at);
		else if (ch === ']' && open.length > 0) closes[open.pop()!] = at;
	}
	open.length = 0;
	for (let at = 0; at < text.length; at += 1) {
		const ch = text[at]!;
		if (ch === '(') open.push(at);
		else if (ch === ')' && open.length > 0) closes[open.pop()!] = at;
		else if (ch === '<' || SPACE.test(ch)) open.length = 0;
	}
	return closes;
}

function closingRun(text: string, from: number, run: number): number {
	let index = text.indexOf('`', from);
	while (index >= 0) {
		const length = runLength(text, index, '`');
		if (length === run) return index;
		index = text.indexOf('`', index + length);
	}
	return -1;
}

function codeText(text: string): string {
	const flat = text.replace(/\n/g, ' ');
	return flat.startsWith(' ') && flat.endsWith(' ') && flat.trim()
		? flat.slice(1, -1)
		: flat;
}

function inlineNodes(
	context: InlineContext,
	from: number,
	to: number,
	depth: number,
	inLink: boolean,
): MarkdownInline[] {
	const { text } = context;
	const nodes: MarkdownInline[] = [];
	/* Per delimiter, the first opener in this range found to have no closer:
	   every later opener of the same delimiter has none either. */
	const exhausted = new Map<string, number>();
	let plain = '';
	const flush = () => {
		if (plain) nodes.push({ kind: 'text', text: plain });
		plain = '';
	};
	let index = from;
	while (index < to) {
		const ch = text[index]!;
		const spanEnd = context.spans.get(index);
		if (spanEnd !== undefined && spanEnd <= to) {
			flush();
			const run = runLength(text, index, '`');
			nodes.push({
				kind: 'code',
				text: codeText(text.slice(index + run, spanEnd - run)),
			});
			index = spanEnd;
			continue;
		}
		if (ch === '\\' && index + 1 < to && ESCAPABLE.test(text[index + 1]!)) {
			plain += text[index + 1];
			index += 2;
			continue;
		}
		if (ch === '[' && !inLink && depth < MAX_INLINE_DEPTH) {
			const link = linkAt(context, index, to, depth);
			if (link) {
				flush();
				nodes.push(...link.nodes);
				index = link.end;
				continue;
			}
		}
		if (
			(ch === 'h' || ch === 'H') &&
			!inLink &&
			(index === from || !WORD.test(text[index - 1]!))
		) {
			const address = autolinkAt(text, index, to);
			if (address) {
				const words = text.slice(index, address.end);
				if (address.href) {
					flush();
					nodes.push({
						kind: 'link',
						href: address.href,
						children: [{ kind: 'text', text: words }],
					});
				} else plain += words;
				index = address.end;
				continue;
			}
		}
		if ((ch === '*' || ch === '_') && depth < MAX_INLINE_DEPTH) {
			const emphasis = emphasisAt(context, index, from, to, exhausted);
			if (emphasis) {
				flush();
				nodes.push({
					kind: emphasis.size === 2 ? 'strong' : 'emphasis',
					children: inlineNodes(
						context,
						index + emphasis.size,
						emphasis.close,
						depth + 1,
						inLink,
					),
				});
				index = emphasis.close + emphasis.size;
				continue;
			}
			const run = Math.min(runLength(text, index, ch), to - index);
			plain += text.slice(index, index + run);
			index += run;
			continue;
		}
		plain += ch;
		index += 1;
	}
	flush();
	return nodes;
}

function emphasisAt(
	context: InlineContext,
	index: number,
	from: number,
	to: number,
	exhausted: Map<string, number>,
): { readonly size: number; readonly close: number } | null {
	const { text } = context;
	const ch = text[index]!;
	const run = Math.min(runLength(text, index, ch), to - index);
	const after = text[index + run];
	if (index + run >= to || after === undefined || SPACE.test(after))
		return null;
	/* An underscore inside a word never opens, so snake_case stays text. */
	if (ch === '_' && index > from && WORD.test(text[index - 1]!)) return null;
	const size = run >= 2 ? 2 : 1;
	const delimiter = ch.repeat(size);
	const failed = exhausted.get(delimiter);
	if (failed !== undefined && failed <= index) return null;
	const close = closingDelimiter(context, index + size, to, ch, size);
	if (close < 0) {
		exhausted.set(delimiter, index);
		return null;
	}
	return { size, close };
}

/* A closer is a run of the same character outside code, not preceded by
   whitespace, of exactly the opener's size or of three (closing strong and
   emphasis at once, its last characters taken). A run of another size belongs
   to a nested pair and is passed over. */
function closingDelimiter(
	context: InlineContext,
	from: number,
	to: number,
	ch: string,
	size: number,
): number {
	const { text } = context;
	let index = text.indexOf(ch, from);
	while (index >= 0 && index < to) {
		const length = Math.min(runLength(text, index, ch), to - index);
		const before = text[index - 1];
		const after = text[index + length];
		const close = index + length - size;
		if (
			!context.code[index] &&
			(length === size || length === 3) &&
			close > from &&
			before !== undefined &&
			before !== '\\' &&
			!SPACE.test(before) &&
			(ch !== '_' || after === undefined || !WORD.test(after))
		)
			return close;
		index = text.indexOf(ch, index + length);
	}
	return -1;
}

function linkAt(
	context: InlineContext,
	index: number,
	to: number,
	depth: number,
): { readonly nodes: readonly MarkdownInline[]; readonly end: number } | null {
	const { text } = context;
	const close = context.closers[index]!;
	if (
		close < 0 ||
		close >= Math.min(to, index + LINK_LABEL_MAX) ||
		text[close + 1] !== '('
	)
		return null;
	const end = context.closers[close + 1]!;
	if (end < 0 || end >= Math.min(to, close + 2 + LINK_URL_MAX)) return null;
	const children = inlineNodes(context, index + 1, close, depth + 1, true);
	const href = safeHref(text.slice(close + 2, end));
	/* An address that may not be a link leaves its words, never the address. */
	return {
		nodes: href ? [{ kind: 'link', href, children }] : children,
		end: end + 1,
	};
}

/* A bare address ends before trailing punctuation, and before a closing
   parenthesis it did not open, so a sentence or a bracket around it stays
   outside the link. One that may not be a link is still taken whole, as text,
   so no address is read twice. */
function autolinkAt(
	text: string,
	index: number,
	to: number,
): { readonly end: number; readonly href: string | null } | null {
	AUTOLINK.lastIndex = index;
	if (!AUTOLINK.test(text) || AUTOLINK.lastIndex >= to) return null;
	let end = AUTOLINK.lastIndex;
	let open = 0;
	let shut = 0;
	for (; end < to && !ADDRESS_END.test(text[end]!); end += 1) {
		if (text[end] === '(') open += 1;
		else if (text[end] === ')') shut += 1;
	}
	for (;;) {
		const ch = text[end - 1]!;
		if (TRAILING_PUNCTUATION.test(ch)) end -= 1;
		else if (ch === ')' && shut > open) {
			shut -= 1;
			end -= 1;
		} else break;
	}
	const address = text.slice(index, end);
	return {
		end,
		href: /^https?:\/\/[^/?#]/i.test(address) ? safeHref(address) : null,
	};
}
