import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import {
	escapeHtml,
	parseFrontMatter,
	renderInline,
	renderMarkdown,
	slug,
} from '../document-markdown.mjs';
import { applyStyle, coverMeta, contents, fill } from '../render-doc.mjs';

test('a heading and its contents entry carry the same number', () => {
	const { html, headings } = renderMarkdown(
		'## First\n\n### Detail\n\n## Second\n',
	);
	deepStrictEqual(
		headings.map((heading) => heading.number),
		['1', '1.1', '2'],
	);
	match(html, /<span class="doc-heading__number">1\.1<\/span>Detail/);
	match(contents(headings), /href="#detail"[\s\S]*?>1\.1</);
});

test('numbering is skipped when the front matter turns it off', () => {
	const { html, headings } = renderMarkdown('## First\n', {
		numbering: false,
	});
	strictEqual(headings.length, 0);
	ok(!html.includes('doc-heading__number'));
});

test('a code span is not reinterpreted as emphasis', () => {
	const html = renderInline('Set `FD_AUTH_MFA_KEY` and *then* boot');
	match(html, /<code class="doc-code">FD_AUTH_MFA_KEY<\/code>/);
	match(html, /<em>then<\/em>/);
});

test('markup in the source is escaped, inside a code span and out', () => {
	strictEqual(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
	const html = renderInline('a `<script>` tag & <b>bold</b>');
	match(html, /<code class="doc-code">&lt;script&gt;<\/code>/);
	ok(!html.includes('<script>'));
	ok(!html.includes('<b>bold</b>'));
});

test('a table keeps its column alignment', () => {
	const { html } = renderMarkdown('| A | B |\n| --- | ---: |\n| 1 | 2 |\n');
	match(html, /<th style="text-align:right">B<\/th>/);
	match(html, /<td style="text-align:right">2<\/td>/);
	match(html, /<td>1<\/td>/);
});

test('a list nests and survives a blank line between items', () => {
	const { html } = renderMarkdown('- one\n  - deep\n\n- two\n');
	match(html, /<ul class="doc-list doc-list--bullet">/);
	match(html, /<li>one<ul[\s\S]*?<li>deep<\/li>[\s\S]*?<\/ul><\/li>/);
	strictEqual(html.match(/<ul /g).length, 2);
	strictEqual(html.match(/<li>/g).length, 3);
});

test('an ordered list is not merged with the bullet list above it', () => {
	const { html } = renderMarkdown('- one\n1. two\n');
	match(html, /doc-list--bullet/);
	match(html, /doc-list--ordered/);
});

test('a tagged blockquote becomes a callout of that kind', () => {
	const { html } = renderMarkdown(
		'> [!danger] Keys are not recoverable\n> Back them up.\n',
	);
	match(html, /<aside class="doc-callout doc-callout--danger">/);
	match(html, /<p class="doc-callout__title">Keys are not recoverable<\/p>/);
	match(html, /Back them up\./);
});

test('an unknown callout tag stays a note and keeps its text', () => {
	const { html } = renderMarkdown('> [!nonsense] Title\n> Body.\n');
	match(html, /doc-callout--note/);
	match(html, /\[!nonsense\] Title/);
});

test('a fenced block is not parsed as markdown', () => {
	const { html } = renderMarkdown(
		'```bash\n# not a heading\n- not a list\n```\n',
	);
	match(html, /<pre class="doc-pre" data-language="bash">/);
	match(html, /# not a heading/);
	ok(!html.includes('<h1'));
	ok(!html.includes('<ul'));
});

test('a page break marker becomes a break element', () => {
	const { html } = renderMarkdown('One\n\n<!-- page -->\n\nTwo\n');
	match(html, /<div class="doc-page-break"><\/div>/);
});

test('front matter is read and separated from the body', () => {
	const { data, body } = parseFrontMatter(
		"---\ntitle: 'Environment Configuration'\nversion: 1.0\n---\n\n## First\n",
	);
	strictEqual(data.title, 'Environment Configuration');
	strictEqual(data.version, '1.0');
	strictEqual(body, '## First');
});

test('a document without front matter keeps its whole body', () => {
	const { data, body } = parseFrontMatter('## First\n');
	deepStrictEqual(data, {});
	strictEqual(body, '## First');
});

test('the cover meta grid is padded to full rows', () => {
	const cells = (data) => coverMeta(data).split('\n').length;
	strictEqual(cells({ docId: 'A' }), 3);
	strictEqual(cells({ docId: 'A', version: '1', status: 'Draft' }), 3);
	strictEqual(cells({ docId: 'A', version: '1', status: 'D', owner: 'P' }), 6);
	match(coverMeta({ docId: 'A' }), /doc-meta__item--filler/);
});

test('the style slot takes the stylesheet, not the note that mentions it', () => {
	const template = [
		'<!doctype html>',
		'<!-- flowdular:note the <!-- flowdular:style --> line is replaced. -->',
		'<html>',
		'\t<head>',
		'\t\t<!-- flowdular:style -->',
		'\t</head>',
		'</html>',
	].join('\n');
	const styled = applyStyle(template, '<style>.doc{color:red}</style>');
	match(styled, /<head>\n<style>\.doc\{color:red\}<\/style>\n\t<\/head>/);
	ok(!styled.includes('flowdular:note'));
	strictEqual(styled.match(/<style>/g).length, 1);
});

test('a template without a style slot is refused rather than rendered bare', () => {
	throws(
		() => applyStyle('<html><head></head></html>', '<style>a{}</style>'),
		/no "<!-- flowdular:style -->" line/,
	);
});

test('a slot the renderer does not fill is left in place', () => {
	strictEqual(fill('{{title}} {{unknown}}', { title: 'A' }), 'A {{unknown}}');
});

test('a replacement carrying $ patterns is inserted literally', () => {
	strictEqual(fill('{{content}}', { content: 'a $& b $1 c' }), 'a $& b $1 c');
});

test('a heading anchor is slugged from its text', () => {
	strictEqual(slug('Keys and `secrets`'), 'keys-and-secrets');
	strictEqual(slug('Bring-up checklist'), 'bring-up-checklist');
});

test('an empty contents list renders nothing', () => {
	strictEqual(contents([]), '');
});
