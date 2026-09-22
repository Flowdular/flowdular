// A Markdown subset, sized to the documents in docs/handbook and no larger. It
// exists so a branded PDF costs no dependency: a parser pulled in for eight
// block types would widen the supply chain that `pnpm audit --prod` guards.
//
// Blocks: ATX headings, paragraphs, ordered and unordered lists with nesting,
// fenced code, GFM tables, blockquote callouts, thematic and page breaks.
// Inline: code spans, links, strong, emphasis.
//
// Sections are numbered here rather than by a CSS counter, because the table of
// contents and the heading have to show the same number and only one of them is
// in the flow a counter can follow.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const LIST_ITEM = /^([ \t]*)([-*]|\d+\.)[ \t]+(.*)$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*$/;
const FENCE = /^([ \t]*)(`{3,})\s*([\w-]*)\s*$/;
const PAGE_BREAK = /^<!--\s*page\s*-->$/;
const THEMATIC_BREAK = /^(-{3,}|\*{3,}|_{3,})$/;
const CALLOUT_TAG = /^\[!([a-z]+)\]\s*(.*)$/i;
const CALLOUT_KINDS = new Set(['note', 'success', 'warning', 'danger']);
/* The placeholder is a character Markdown cannot produce and the escaper does
   not touch, so a lifted code span cannot be rewritten while it is parked. */
const PLACEHOLDER = '\u0000';

export function escapeHtml(value) {
	return value.replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

export function slug(text) {
	return text
		.toLowerCase()
		.replace(/`|\*|_/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function renderInline(source) {
	const codes = [];
	const lifted = source.replace(/`([^`]+)`/g, (_, code) => {
		codes.push(code);
		return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
	});
	const marked = escapeHtml(lifted)
		.replace(
			/\[([^\]]+)\]\(([^)\s]+)\)/g,
			'<a class="doc-link" href="$2">$1</a>',
		)
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
	return marked.replace(
		new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
		(_, index) =>
			`<code class="doc-code">${escapeHtml(codes[Number(index)])}</code>`,
	);
}

function indentWidth(text) {
	let width = 0;
	for (const character of text) width += character === '\t' ? 4 : 1;
	return width;
}

function separatorCells(line) {
	if (!line || !line.includes('|')) return null;
	const cells = tableCells(line);
	if (cells.length === 0) return null;
	return cells.every((cell) => /^:?-{2,}:?$/.test(cell)) ? cells : null;
}

function tableCells(line) {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

function alignmentOf(cell) {
	if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
	if (cell.endsWith(':')) return 'right';
	return null;
}

function takeTable(lines, start) {
	const alignments = separatorCells(lines[start + 1]).map(alignmentOf);
	const head = tableCells(lines[start]);
	const rows = [];
	let index = start + 2;
	while (index < lines.length && lines[index].includes('|')) {
		rows.push(tableCells(lines[index]));
		index += 1;
	}
	const cell = (tag, value, column) => {
		const align = alignments[column];
		const attribute = align ? ` style="text-align:${align}"` : '';
		return `<${tag}${attribute}>${renderInline(value ?? '')}</${tag}>`;
	};
	const body = rows
		.map(
			(row) =>
				`<tr>${head.map((_, column) => cell('td', row[column], column)).join('')}</tr>`,
		)
		.join('\n');
	const html = [
		'<div class="doc-table-wrap">',
		'<table class="doc-table">',
		`<thead><tr>${head.map((value, column) => cell('th', value, column)).join('')}</tr></thead>`,
		`<tbody>\n${body}\n</tbody>`,
		'</table>',
		'</div>',
	].join('\n');
	return { html, next: index };
}

function takeFence(lines, start) {
	const [, , ticks, language] = FENCE.exec(lines[start]);
	const closing = new RegExp(`^[ \\t]*\`{${ticks.length},}\\s*$`);
	const collected = [];
	let index = start + 1;
	while (index < lines.length && !closing.test(lines[index])) {
		collected.push(lines[index]);
		index += 1;
	}
	const attribute = language ? ` data-language="${escapeHtml(language)}"` : '';
	const html = `<pre class="doc-pre"${attribute}><code>${escapeHtml(collected.join('\n'))}</code></pre>`;
	return { html, next: index < lines.length ? index + 1 : index };
}

function takeCallout(lines, start, context) {
	const collected = [];
	let index = start;
	while (index < lines.length && lines[index].startsWith('>')) {
		collected.push(lines[index].replace(/^>[ \t]?/, ''));
		index += 1;
	}
	let kind = 'note';
	let title = '';
	const tagged = CALLOUT_TAG.exec(collected[0] ?? '');
	if (tagged && CALLOUT_KINDS.has(tagged[1].toLowerCase())) {
		kind = tagged[1].toLowerCase();
		title = tagged[2].trim();
		collected.shift();
	}
	const heading = title
		? `<p class="doc-callout__title">${renderInline(title)}</p>`
		: '';
	const inner = renderBlocks(collected, context);
	const html = `<aside class="doc-callout doc-callout--${kind}">${heading}${inner}</aside>`;
	return { html, next: index };
}

function takeList(lines, start, context) {
	const first = LIST_ITEM.exec(lines[start]);
	const indent = indentWidth(first[1]);
	const ordered = /\d/.test(first[2]);
	const items = [];
	let index = start;
	while (index < lines.length) {
		if (lines[index].trim() === '') {
			/* One blank line between items keeps the list together; markdown calls
			   this a loose list, and the documents here use it for readability. */
			const next = LIST_ITEM.exec(lines[index + 1] ?? '');
			if (!next || indentWidth(next[1]) < indent) break;
			index += 1;
			continue;
		}
		const match = LIST_ITEM.exec(lines[index]);
		if (!match) break;
		const width = indentWidth(match[1]);
		if (width < indent) break;
		if (width > indent) {
			const nested = takeList(lines, index, context);
			if (items.length > 0) items[items.length - 1].children += nested.html;
			index = nested.next;
			continue;
		}
		if (/\d/.test(match[2]) !== ordered) break;
		items.push({ text: match[3], children: '' });
		index += 1;
	}
	const tag = ordered ? 'ol' : 'ul';
	const body = items
		.map((item) => `<li>${renderInline(item.text)}${item.children}</li>`)
		.join('\n');
	return {
		html: `<${tag} class="doc-list doc-list--${ordered ? 'ordered' : 'bullet'}">\n${body}\n</${tag}>`,
		next: index,
	};
}

function takeParagraph(lines, start) {
	const collected = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (
			line.trim() === '' ||
			HEADING.test(line) ||
			FENCE.test(line) ||
			LIST_ITEM.test(line) ||
			line.startsWith('>') ||
			THEMATIC_BREAK.test(line.trim()) ||
			PAGE_BREAK.test(line.trim())
		)
			break;
		collected.push(line.trim());
		index += 1;
	}
	return {
		html: `<p class="doc-p">${renderInline(collected.join(' '))}</p>`,
		next: index,
	};
}

function headingNumber(level, context) {
	if (level === 2) {
		context.section += 1;
		context.subsection = 0;
		return `${context.section}`;
	}
	context.subsection += 1;
	return `${context.section}.${context.subsection}`;
}

function renderBlocks(lines, context) {
	const html = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === '') {
			index += 1;
			continue;
		}
		if (FENCE.test(line)) {
			const fence = takeFence(lines, index);
			html.push(fence.html);
			index = fence.next;
			continue;
		}
		if (PAGE_BREAK.test(line.trim())) {
			html.push('<div class="doc-page-break"></div>');
			index += 1;
			continue;
		}
		if (THEMATIC_BREAK.test(line.trim())) {
			html.push('<hr class="doc-rule" />');
			index += 1;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2];
			const id = slug(text);
			const numbered = context.numbering && (level === 2 || level === 3);
			const number = numbered ? headingNumber(level, context) : '';
			const label = number
				? `<span class="doc-heading__number">${number}</span>`
				: '';
			html.push(
				`<h${level} class="doc-heading doc-heading--${level}" id="${id}">${label}${renderInline(text)}</h${level}>`,
			);
			if (numbered)
				context.headings.push({ level, id, number, text: renderInline(text) });
			index += 1;
			continue;
		}
		if (line.startsWith('>')) {
			const callout = takeCallout(lines, index, context);
			html.push(callout.html);
			index = callout.next;
			continue;
		}
		if (separatorCells(lines[index + 1]) && line.includes('|')) {
			const table = takeTable(lines, index);
			html.push(table.html);
			index = table.next;
			continue;
		}
		if (LIST_ITEM.test(line)) {
			const list = takeList(lines, index, context);
			html.push(list.html);
			index = list.next;
			continue;
		}
		const paragraph = takeParagraph(lines, index);
		html.push(paragraph.html);
		index = paragraph.next;
	}
	return html.join('\n');
}

/** Renders a document body and the numbered headings a table of contents needs. */
export function renderMarkdown(source, { numbering = true } = {}) {
	const context = { headings: [], numbering, section: 0, subsection: 0 };
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	return { html: renderBlocks(lines, context), headings: context.headings };
}

/** Reads the `key: value` header a document opens with, and the body after it. */
export function parseFrontMatter(source) {
	const normalized = source.replace(/\r\n/g, '\n');
	if (!normalized.startsWith('---\n'))
		return { data: {}, body: normalized.trim() };
	const end = normalized.indexOf('\n---', 3);
	if (end === -1) return { data: {}, body: normalized.trim() };
	const data = {};
	for (const line of normalized.slice(4, end).split('\n')) {
		const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		data[match[1]] = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
	}
	const body = normalized.slice(end + 4).replace(/^\n/, '');
	return { data, body: body.trim() };
}
