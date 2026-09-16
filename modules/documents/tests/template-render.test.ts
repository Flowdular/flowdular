import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import {
	compileTemplate,
	normalizeTemplateLayout,
} from '../src/domain/template-compile.ts';
import {
	evaluateTemplate,
	TemplateRenderError,
} from '../src/domain/template-evaluate.ts';
import type { TemplateObjectSchema } from '../src/domain/template-schema.ts';
import type { DocumentTemplateFormat } from '../src/domain/templates.ts';
import { createDocumentRenderers } from '../src/services/render/renderer.ts';
import { readDocumentText } from '../src/services/text/extract.ts';

const SCHEMA: TemplateObjectSchema = {
	type: 'object',
	properties: {
		client: { type: 'string' },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: { name: { type: 'string' }, quantity: { type: 'integer' } },
			},
		},
	},
};

const BODY = [
	'# Oferta dla {{ client }}',
	'',
	'Zażółć **gęślą** jaźń.',
	'',
	'- pierwszy punkt',
	'  - zagnieżdżony',
	'1. numer jeden',
	'',
	'> Cytat ŁÓDŹ',
	'',
	'| Pozycja | Ilość |',
	'| --- | ---: |',
	'{{#each items}}',
	'| {{ name }} | {{ quantity }} |',
	'{{/each}}',
	'',
	'---pagebreak---',
	'',
	'Koniec.',
].join('\n');

function renderedFor(rows: number) {
	const { layout } = normalizeTemplateLayout(
		{
			header: 'Nagłówek {{ client }}',
			footer: 'Strona {{ page }} z {{ pages }}',
			title: 'Oferta {{ client }}',
		},
		'Oferta',
	);
	const { compiled, issues } = compileTemplate({
		body: BODY,
		layout,
		inputSchema: SCHEMA,
		locale: 'pl',
		format: 'pdf',
	});
	expect(issues).toEqual([]);
	const document = evaluateTemplate(
		compiled!,
		{
			client: 'Spółka Żółw',
			items: Array.from({ length: rows }, (_, index) => ({
				name: `Pozycja ${index + 1} źdźbło`,
				quantity: index + 1,
			})),
		},
		{ locale: 'pl', timeZone: 'Europe/Warsaw' },
	);
	return { document, layout };
}

async function renderBytes(format: DocumentTemplateFormat, rows: number) {
	const { document, layout } = renderedFor(rows);
	return createDocumentRenderers()[format].render(document, layout, {
		createdAt: Date.UTC(2026, 8, 16),
	});
}

async function readBack(format: DocumentTemplateFormat, bytes: Uint8Array) {
	const outcome = await readDocumentText({
		contentType: createDocumentRenderers()[format].contentType,
		bytes,
		limits: DOCUMENT_TEXT_LIMITS,
	});
	if (outcome.kind !== 'text')
		throw new Error(`Unreadable: ${JSON.stringify(outcome)}`);
	return outcome.pages;
}

/* The package's own parts, for what the text reader does not read. */
function zipPart(bytes: Uint8Array, name: string): string {
	const buffer = Buffer.from(bytes);
	let offset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const entries = buffer.readUInt16LE(offset + 10);
	offset = buffer.readUInt32LE(offset + 16);
	for (let entry = 0; entry < entries; entry += 1) {
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extra = buffer.readUInt16LE(offset + 30);
		const comment = buffer.readUInt16LE(offset + 32);
		const entryName = buffer.toString(
			'utf8',
			offset + 46,
			offset + 46 + nameLength,
		);
		if (entryName === name) {
			const method = buffer.readUInt16LE(offset + 10);
			const size = buffer.readUInt32LE(offset + 20);
			const local = buffer.readUInt32LE(offset + 42);
			const start =
				local +
				30 +
				buffer.readUInt16LE(local + 26) +
				buffer.readUInt16LE(local + 28);
			const data = buffer.subarray(start, start + size);
			return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
		}
		offset += 46 + nameLength + extra + comment;
	}
	throw new Error(`No part ${name}.`);
}

describe('template renderers', () => {
	it('DOCUMENTS-TEMPLATE-PDF reads back the text, the table across pages with its header row, the page numbers and Polish characters', async () => {
		const bytes = await renderBytes('pdf', 120);
		expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
		const pages = await readBack('pdf', bytes);
		expect(pages.length).toBeGreaterThanOrEqual(4);
		const first = pages[0]!;
		expect(first).toContain('Oferta dla Spółka Żółw');
		expect(first).toContain('Zażółć gęślą jaźń.');
		expect(first).toContain('Nagłówek Spółka Żółw');
		expect(first).toContain('Cytat ŁÓDŹ');
		expect(first).toContain('Pozycja 1 źdźbło');
		const tablePages = pages.filter((page) => /Pozycja \d+ źdźbło/.test(page));
		expect(tablePages.length).toBeGreaterThan(1);
		for (const page of tablePages) {
			expect(page).toMatch(/Pozycja\s+Ilość/);
		}
		const second = tablePages[1]!;
		const firstRowOnSecond = Number(/Pozycja (\d+) źdźbło/.exec(second)![1]);
		const lastRowOnFirst = Math.max(
			...[...tablePages[0]!.matchAll(/Pozycja (\d+) źdźbło/g)].map((match) =>
				Number(match[1]),
			),
		);
		expect(firstRowOnSecond).toBe(lastRowOnFirst + 1);
		const joined = pages.join('\n');
		for (let row = 1; row <= 120; row += 1) {
			expect(joined).toContain(`Pozycja ${row} źdźbło`);
		}
		pages.forEach((page, index) => {
			expect(page).toContain(`Strona ${index + 1} z ${pages.length}`);
		});
		expect(pages.at(-1)).toContain('Koniec.');
	});

	it('DOCUMENTS-TEMPLATE-PDF refuses a document past 200 pages', async () => {
		const { layout } = normalizeTemplateLayout({}, 'x');
		const { compiled } = compileTemplate({
			body: '{{#each items}}\n{{ name }}\n\n---pagebreak---\n{{/each}}',
			layout,
			inputSchema: SCHEMA,
			locale: 'en',
			format: 'pdf',
		});
		const document = evaluateTemplate(
			compiled!,
			{
				items: Array.from({ length: 201 }, (_, index) => ({
					name: String(index),
					quantity: 1,
				})),
			},
			{ locale: 'en', timeZone: 'UTC' },
		);
		await expect(
			createDocumentRenderers().pdf.render(document, layout, { createdAt: 0 }),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof TemplateRenderError &&
				error.code === 'TEMPLATE_PAGES_EXCEEDED',
		);
	});

	it('DOCUMENTS-TEMPLATE-DOCX reads back every block and row, repeats the header row and carries the page fields', async () => {
		const bytes = await renderBytes('docx', 30);
		expect(Buffer.from(bytes.subarray(0, 2)).toString('latin1')).toBe('PK');
		const text = (await readBack('docx', bytes)).join('\n');
		const lines = text
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		expect(lines.slice(0, 5)).toEqual([
			'Oferta dla Spółka Żółw',
			'Zażółć gęślą jaźń.',
			'pierwszy punkt',
			'zagnieżdżony',
			'numer jeden',
		]);
		expect(lines).toContain('Cytat ŁÓDŹ');
		const header = lines.indexOf('Pozycja');
		expect(lines.slice(header, header + 5)).toEqual([
			'Pozycja',
			'Ilość',
			'Pozycja 1 źdźbło',
			'1',
			'Pozycja 2 źdźbło',
		]);
		for (let row = 1; row <= 30; row += 1) {
			expect(lines).toContain(`Pozycja ${row} źdźbło`);
		}
		expect(lines.at(-1)).toBe('Koniec.');
		const documentXml = zipPart(bytes, 'word/document.xml');
		expect(documentXml).toContain('<w:tblHeader/>');
		expect(documentXml).toContain('<w:br w:type="page"/>');
		const footer = zipPart(bytes, 'word/footer1.xml');
		expect(footer).toContain('Strona ');
		expect(footer).toMatch(/PAGE/);
		expect(footer).toMatch(/NUMPAGES/);
		expect(zipPart(bytes, 'word/header1.xml')).toContain(
			'Nagłówek Spółka Żółw',
		);
		expect(zipPart(bytes, 'docProps/core.xml')).toContain('Oferta Spółka Żółw');
	});
});
