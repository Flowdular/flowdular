/// <reference path="./pdfmake.d.ts" />
import type {
	RenderedBlock,
	RenderedLine,
	RenderedList,
	RenderedMarginLine,
	RenderedTemplate,
} from '../../domain/template-evaluate.ts';
import { TemplateRenderError } from '../../domain/template-evaluate.ts';
import {
	DOCUMENT_TEMPLATE_LIMITS,
	type DocumentTemplateLayout,
} from '../../domain/templates.ts';
import {
	commonJsDefault,
	MILLIMETRE_IN_POINTS,
	type DocumentRenderer,
	type RenderOptions,
} from './renderer.ts';

type Content = Record<string, unknown> | string;

/* The surface of pdfmake's prebuilt bundle the renderer uses. */
interface PdfMake {
	addVirtualFileSystem(files: Readonly<Record<string, string>>): void;
	setFonts(
		fonts: Readonly<Record<string, Readonly<Record<string, string>>>>,
	): void;
	setUrlAccessPolicy(policy: (url: string) => boolean): void;
	localAccessPolicy?: (path: string) => boolean;
	createPdf(definition: Record<string, unknown>): {
		getBuffer(): Promise<Uint8Array>;
	};
}

const FONT = 'Roboto';
const FONT_FILES = {
	normal: 'Roboto-Regular.ttf',
	bold: 'Roboto-Medium.ttf',
	italics: 'Roboto-Italic.ttf',
	bolditalics: 'Roboto-MediumItalic.ttf',
} as const;
const PAGE_WIDTH = { A4: 595.28, Letter: 612 } as const;

let library: Promise<PdfMake> | null = null;

/* Loaded on the first render, so a process that never renders never parses
   the layout engine or decodes the fonts. The prebuilt bundle is used rather
   than pdfmake's Node entry: it carries the same pdfkit and fontkit, and a
   server bundle can take it in without the brotli dictionary source the
   platform build cannot transform. Its file system holds the four Roboto faces
   and nothing else, and both access policies refuse everything, so a document
   can reach no URL and no file. */
function loadLibrary(): Promise<PdfMake> {
	library ??= (async () => {
		const [bundle, fonts] = await Promise.all([
			import('pdfmake/build/pdfmake.js'),
			import('pdfmake/build/vfs_fonts.js'),
		]);
		const pdfmake = commonJsDefault<PdfMake>(bundle);
		const encoded = commonJsDefault<Record<string, string>>(fonts);
		pdfmake.addVirtualFileSystem(
			Object.fromEntries(
				Object.values(FONT_FILES).map((name) => [name, encoded[name] ?? '']),
			),
		);
		pdfmake.setFonts({ [FONT]: { ...FONT_FILES } });
		pdfmake.setUrlAccessPolicy(() => false);
		pdfmake.localAccessPolicy = () => false;
		return pdfmake;
	})();
	return library;
}

function runs(line: RenderedLine): Content[] {
	return line.map((run) => ({
		text: run.text,
		...(run.bold ? { bold: true } : {}),
		...(run.italic ? { italics: true } : {}),
		...(run.code ? { background: '#eeeeee' } : {}),
	}));
}

function list(source: RenderedList): Content {
	const items = source.items.map((item) =>
		item.sublist
			? { stack: [{ text: runs(item.runs) }, list(item.sublist)] }
			: { text: runs(item.runs) },
	);
	return source.ordered
		? { ol: items, start: source.start, margin: [0, 0, 0, 6] }
		: { ul: items, margin: [0, 0, 0, 6] };
}

function block(source: RenderedBlock, contentWidth: number): Content {
	switch (source.kind) {
		case 'heading':
			return { text: runs(source.runs), style: `h${source.level}` };
		case 'paragraph':
			return { text: runs(source.runs), margin: [0, 0, 0, 6] };
		case 'list':
			return list(source);
		case 'quote':
			return {
				table: {
					widths: ['*'],
					body: [
						[
							{
								stack: source.paragraphs.map((paragraph) => ({
									text: runs(paragraph),
									margin: [0, 0, 0, 4],
								})),
								color: '#444444',
							},
						],
					],
				},
				layout: {
					hLineWidth: () => 0,
					vLineWidth: (index: number) => (index === 0 ? 2 : 0),
					vLineColor: () => '#bbbbbb',
					paddingLeft: () => 10,
				},
				margin: [0, 0, 0, 6],
			};
		case 'rule':
			return {
				canvas: [
					{
						type: 'line',
						x1: 0,
						y1: 0,
						x2: contentWidth,
						y2: 0,
						lineWidth: 0.5,
						lineColor: '#999999',
					},
				],
				margin: [0, 4, 0, 8],
			};
		case 'pagebreak':
			return { text: '', pageBreak: 'after' };
		case 'table': {
			const cell = (line: RenderedLine, column: number, header: boolean) => ({
				text: runs(line),
				alignment: source.align[column],
				...(header ? { bold: true } : {}),
			});
			return {
				table: {
					headerRows: 1,
					dontBreakRows: true,
					widths: source.align.map(() => '*'),
					body: [
						source.header.map((line, column) => cell(line, column, true)),
						...source.rows.map((row) =>
							source.align.map((_, column) =>
								cell(row[column] ?? [], column, false),
							),
						),
					],
				},
				layout: 'lightHorizontalLines',
				margin: [0, 2, 0, 8],
			};
		}
	}
}

function margin(line: RenderedMarginLine, page: number, pages: number): string {
	return line
		.map((part) =>
			typeof part === 'string'
				? part
				: String(part.counter === 'page' ? page : pages),
		)
		.join('');
}

export const pdfRenderer: DocumentRenderer = {
	format: 'pdf',
	contentType: 'application/pdf',
	extension: 'pdf',
	async render(
		document: RenderedTemplate,
		layout: DocumentTemplateLayout,
		options: RenderOptions,
	): Promise<Uint8Array> {
		options.signal?.throwIfAborted();
		const pdfmake = await loadLibrary();
		const margins = [
			layout.margins.left,
			layout.margins.top,
			layout.margins.right,
			layout.margins.bottom,
		].map((value) => value * MILLIMETRE_IN_POINTS);
		const [left, top, right, bottom] = margins as [
			number,
			number,
			number,
			number,
		];
		const contentWidth = PAGE_WIDTH[layout.pageSize] - left - right;
		/* pdfmake asks for the header and footer of every page once the page
		   count is known and before any byte is written, so the page bound is
		   enforced there. */
		const marginLine =
			(
				line: RenderedMarginLine | null,
				offset: [number, number, number, number],
			) =>
			(page: number, pages: number) => {
				if (pages > DOCUMENT_TEMPLATE_LIMITS.pages) {
					throw new TemplateRenderError(
						'TEMPLATE_PAGES_EXCEEDED',
						`A PDF holds at most ${DOCUMENT_TEMPLATE_LIMITS.pages} pages.`,
					);
				}
				return line
					? {
							text: margin(line, page, pages),
							margin: offset,
							fontSize: 8,
							color: '#555555',
						}
					: null;
			};
		const pdf = pdfmake.createPdf({
			pageSize: layout.pageSize === 'Letter' ? 'LETTER' : 'A4',
			pageMargins: margins,
			info: {
				title: document.title,
				creator: 'Flowdular',
				producer: 'Flowdular',
				creationDate: new Date(options.createdAt),
			},
			language: document.locale,
			defaultStyle: { font: FONT, fontSize: 10, lineHeight: 1.2 },
			styles: {
				h1: { fontSize: 18, bold: true, margin: [0, 6, 0, 6] },
				h2: { fontSize: 14, bold: true, margin: [0, 6, 0, 4] },
				h3: { fontSize: 12, bold: true, margin: [0, 4, 0, 4] },
			},
			header: marginLine(document.header, [
				left,
				Math.max(8, top / 2 - 6),
				right,
				0,
			]),
			footer: marginLine(document.footer, [
				left,
				Math.max(4, bottom / 2 - 6),
				right,
				0,
			]),
			content: document.blocks.map((entry) => block(entry, contentWidth)),
		});
		const bytes = await pdf.getBuffer();
		options.signal?.throwIfAborted();
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	},
};
