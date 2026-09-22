// Renders the markdown in docs/handbook into a branded, self-contained HTML
// document that prints to PDF without a layout surprise. Fonts, the packages/ui
// tokens and the document stylesheet are inlined, so the output file can be
// emailed or archived on its own.
//
// Convention: the cover comes from the front matter, `##` opens a numbered
// section and `###` a numbered subsection. `<!-- page -->` forces a page break.
//
// Run: node scripts/render-doc.mjs --all
//      node scripts/render-doc.mjs docs/handbook/environment-configuration.md
//      node scripts/render-doc.mjs --all --pdf
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
	escapeHtml,
	parseFrontMatter,
	renderMarkdown,
} from './document-markdown.mjs';

const root = new URL('..', import.meta.url).pathname;
const SOURCE = join(root, 'docs/handbook');
const TEMPLATE = join(root, 'docs/templates/document.html');
const STYLESHEET = join(root, 'docs/templates/document.css');
const TOKENS = join(root, 'packages/ui/src/styles/tokens.css');
const LOGO = join(root, 'docs/assets/flowdular-logo.svg');
const OUTPUT = join(root, 'release-artifacts/docs');
const CHROME =
	process.env.FD_CHROME ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* The latin subsets only. A document that reaches for Cyrillic or Greek should
   add the file it needs here rather than carry every subset in every PDF. */
const FONTS = [
	{
		family: 'IBM Plex Sans Variable',
		style: 'normal',
		weight: '100 700',
		format: 'woff2-variations',
		file: 'packages/ui/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2',
	},
	{
		family: 'IBM Plex Sans Variable',
		style: 'italic',
		weight: '100 700',
		format: 'woff2-variations',
		file: 'packages/ui/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-italic.woff2',
	},
	{
		family: 'IBM Plex Mono',
		style: 'normal',
		weight: '400',
		format: 'woff2',
		file: 'packages/ui/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
	},
];

const META_FIELDS = [
	['docId', 'Document'],
	['version', 'Version'],
	['status', 'Status'],
	['owner', 'Owner'],
	['approver', 'Approver'],
	['audience', 'Audience'],
	['date', 'Date'],
	['nextReview', 'Next review'],
];

const CLASSIFICATIONS = new Set(['restricted', 'confidential']);

export function coverClassification(value) {
	if (!value) return '';
	const key = value.trim().toLowerCase();
	const modifier = CLASSIFICATIONS.has(key) ? ` doc-pill--${key}` : '';
	return `<span class="doc-pill${modifier}">${escapeHtml(value)}</span>`;
}

const META_COLUMNS = 3;

export function coverMeta(data) {
	const items = META_FIELDS.filter(([key]) => data[key]).map(
		([key, label]) =>
			`<div class="doc-meta__item"><span class="doc-meta__label">${label}</span><span class="doc-meta__value">${escapeHtml(data[key])}</span></div>`,
	);
	/* The grid draws a rule under every cell, so a part-filled last row would
	   end in a stub. Empty cells carry the rule to the edge. */
	const fillers = (META_COLUMNS - (items.length % META_COLUMNS)) % META_COLUMNS;
	for (let index = 0; index < fillers; index += 1)
		items.push(
			'<div class="doc-meta__item doc-meta__item--filler" aria-hidden="true"></div>',
		);
	return items.join('\n');
}

export function contents(headings) {
	if (headings.length === 0) return '';
	const items = headings
		.map(
			(heading) =>
				`<li class="doc-toc__item doc-toc__item--${heading.level}"><a class="doc-toc__link" href="#${heading.id}"><span class="doc-toc__number">${heading.number}</span><span>${heading.text}</span></a></li>`,
		)
		.join('\n');
	return `<nav class="doc-toc"><h2 class="doc-toc__title">Contents</h2><ol class="doc-toc__list">\n${items}\n</ol></nav>`;
}

function footer(data) {
	const left = ['Flowdular', data.docId, data.version && `v${data.version}`]
		.filter(Boolean)
		.map((part) => escapeHtml(part))
		.join(' · ');
	const right = [data.classification, data.date]
		.filter(Boolean)
		.map((part) => escapeHtml(part))
		.join(' · ');
	return `<span>${left}</span><span>${right}</span>`;
}

async function styleElement() {
	const faces = await Promise.all(
		FONTS.map(async (font) => {
			const bytes = await readFile(join(root, font.file));
			const source = `url(data:font/woff2;base64,${bytes.toString('base64')}) format('${font.format}')`;
			return `@font-face{font-family:'${font.family}';font-style:${font.style};font-weight:${font.weight};font-display:swap;src:${source};}`;
		}),
	);
	const tokens = await readFile(TOKENS, 'utf8');
	const stylesheet = await readFile(STYLESHEET, 'utf8');
	return `<style>\n${faces.join('\n')}\n${tokens}\n${stylesheet}</style>`;
}

/**
 * Puts the stylesheet in the template's style slot and drops the authoring note.
 * The slot is matched on its own line, because the note mentions the marker and
 * a plain string replace hands the stylesheet to the note instead.
 */
export function applyStyle(page, style) {
	const styled = page
		.replace(/^[ \t]*<!-- flowdular:style -->[ \t]*$/m, () => style)
		.replace(/<!-- flowdular:note[\s\S]*?-->\n?/g, '');
	if (!styled.includes('<style>'))
		throw new Error(
			'docs/templates/document.html has no "<!-- flowdular:style -->" line of its own; the document would render unstyled.',
		);
	return styled;
}

export function fill(template, slots) {
	return template.replace(
		/\{\{(\w+)\}\}/g,
		(match, key) => slots[key] ?? match,
	);
}

async function renderDocument(file, style, template, logo) {
	const { data, body } = parseFrontMatter(await readFile(file, 'utf8'));
	if (!data.title)
		throw new Error(
			`${relative(root, file)} has no "title" in its front matter.`,
		);
	const { html, headings } = renderMarkdown(body, {
		numbering: data.numbering !== 'false',
	});
	const page = fill(template, {
		lang: escapeHtml(data.lang ?? 'en'),
		title: escapeHtml(data.title),
		description: escapeHtml(data.subtitle ?? data.title),
		logo,
		classification: coverClassification(data.classification),
		eyebrow: data.eyebrow
			? `<p class="doc-cover__eyebrow">${escapeHtml(data.eyebrow)}</p>`
			: '',
		subtitle: data.subtitle
			? `<p class="doc-cover__subtitle">${escapeHtml(data.subtitle)}</p>`
			: '',
		meta: coverMeta(data),
		toc: contents(headings),
		content: html,
		footer: footer(data),
	});
	const styled = applyStyle(page, style);
	const destination = join(
		OUTPUT,
		`${basename(file).replace(/\.md$/, '')}.html`,
	);
	await mkdir(OUTPUT, { recursive: true });
	await writeFile(destination, styled);
	return destination;
}

async function printPdf(file) {
	const destination = file.replace(/\.html$/, '.pdf');
	const chrome = spawn(
		CHROME,
		[
			'--headless',
			'--disable-gpu',
			'--no-pdf-header-footer',
			`--print-to-pdf=${destination}`,
			`file://${file}`,
		],
		{ stdio: 'ignore' },
	);
	const code = await new Promise((settle) => chrome.once('close', settle));
	if (code !== 0) {
		console.error(
			`Chrome exited with ${code}. Set FD_CHROME to the browser binary if it lives elsewhere.`,
		);
		process.exit(1);
	}
	return destination;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const argv = process.argv.slice(2);
	const pdf = argv.includes('--pdf');
	const named = argv.filter((argument) => !argument.startsWith('--'));
	const files =
		named.length > 0
			? named.map((name) => resolve(process.cwd(), name))
			: (await readdir(SOURCE))
					.filter((name) => name.endsWith('.md'))
					.sort()
					.map((name) => join(SOURCE, name));
	if (files.length === 0) {
		console.error(`No markdown to render in ${relative(root, SOURCE)}.`);
		process.exit(1);
	}
	const style = await styleElement();
	const template = await readFile(TEMPLATE, 'utf8');
	const logo = (await readFile(LOGO, 'utf8')).trim();
	for (const file of files) {
		const rendered = await renderDocument(file, style, template, logo);
		console.log(`Rendered ${relative(root, rendered)}`);
		if (pdf)
			console.log(`Printed  ${relative(root, await printPdf(rendered))}`);
	}
}
