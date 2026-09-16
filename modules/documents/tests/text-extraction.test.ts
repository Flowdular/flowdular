import { describe, expect, it } from 'vitest';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import {
	readDocumentText,
	type DocumentTextLimits,
} from '../src/services/text/extract.ts';
import { pngBytes } from './support/files.ts';
import {
	docxBytes,
	DOCX_TYPE,
	encryptedPdf,
	paragraph,
	pdfDocument,
	pptxBytes,
	PPTX_TYPE,
	xlsxBytes,
	XLSX_TYPE,
	zipBytes,
} from './support/text-fixtures.ts';

function read(
	contentType: string,
	bytes: Uint8Array,
	limits: Partial<DocumentTextLimits> = {},
) {
	return readDocumentText({
		contentType,
		bytes,
		limits: { ...DOCUMENT_TEXT_LIMITS, ...limits },
	});
}

const SHEETS = xlsxBytes(
	[
		{
			name: 'Claims',
			rows:
				'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Paid</t></is></c></row>' +
				'<row r="2"><c r="A2"><v>17</v></c><c r="C2" t="b"><v>1</v></c></row>' +
				'<row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c><c r="D3" t="str"><f>SUM(A2)</f><v>17</v></c></row>',
		},
		{
			name: 'Totals',
			rows: '<row r="1"><c r="B1" t="s"><v>0</v></c></row>',
		},
	],
	'<si><t>Claim</t></si><si><r><t>Am</t></r><r><t>ount</t></r><rPh><t>phonetic</t></rPh></si>',
);

describe('documents text extraction', () => {
	it('DOCUMENTS-TEXT-FORMATS reads the text layer of a PDF page by page', async () => {
		expect(
			await read(
				'application/pdf',
				pdfDocument(['First (page)', 'Second page']),
			),
		).toEqual({
			kind: 'text',
			pages: ['First (page)', 'Second page'],
			pageCount: 2,
			truncated: false,
		});
	});

	it('DOCUMENTS-TEXT-FORMATS reads a DOCX body with tabs and breaks, ignoring tab stops and fallback copies', async () => {
		const body =
			paragraph('Policy\tnumber 42') +
			paragraph('Insured: Acme & Sons\nSecond line') +
			'<w:p><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:r><w:t>Box text</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>Box text</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>' +
			'<w:p><w:r><w:delText>deleted</w:delText><w:instrText>PAGE</w:instrText></w:r></w:p>';
		expect(await read(DOCX_TYPE, docxBytes(body))).toEqual({
			kind: 'text',
			pages: ['Policy\tnumber 42\nInsured: Acme & Sons\nSecond line\nBox text'],
			pageCount: 1,
			truncated: false,
		});
	});

	it('DOCUMENTS-TEXT-FORMATS reads an XLSX as one block per sheet with tab separated rows', async () => {
		expect(await read(XLSX_TYPE, SHEETS)).toEqual({
			kind: 'text',
			pages: [
				'Claims\nClaim\tAmount\tPaid\n17\t\tTRUE\n#DIV/0!\t\t\t17',
				'Totals\n\tClaim',
			],
			pageCount: 2,
			truncated: false,
		});
	});

	it('DOCUMENTS-TEXT-FORMATS reads PPTX slides in presentation order', async () => {
		const slides = pptxBytes([
			'<a:p><a:r><a:t>Title one</a:t></a:r></a:p>',
			'<a:p><a:r><a:t>Line</a:t></a:r><a:br/><a:r><a:t>break</a:t></a:r></a:p><a:p><a:r><a:t>Last</a:t></a:r></a:p>',
		]);
		expect(await read(PPTX_TYPE, slides)).toEqual({
			kind: 'text',
			pages: ['Title one', 'Line\nbreak\nLast'],
			pageCount: 2,
			truncated: false,
		});
	});

	it('DOCUMENTS-TEXT-FORMATS reads CSV and plain text with line ends normalized', async () => {
		const csv = new TextEncoder().encode('name,amount\r\nAcme,17\r\n');
		expect(await read('text/csv', csv)).toEqual({
			kind: 'text',
			pages: ['name,amount\nAcme,17'],
			pageCount: 1,
			truncated: false,
		});
		const text = new TextEncoder().encode(
			String.fromCharCode(0xfeff) + 'Zażółć gęślą jaźń\n',
		);
		expect((await read('text/plain; charset=utf-8', text)).kind).toBe('text');
		expect(await read('text/plain', text)).toMatchObject({
			pages: ['Zażółć gęślą jaźń'],
		});
	});

	it('DOCUMENTS-TEXT-FORMATS refuses the legacy Office formats, unknown types and bytes that do not match their type', async () => {
		const ole = Buffer.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0);
		expect(await read('application/msword', ole)).toEqual({
			kind: 'refused',
			status: 'unsupported',
			reason: 'DOCUMENT_TEXT_FORMAT',
		});
		expect(await read('application/zip', zipBytes([]))).toMatchObject({
			reason: 'DOCUMENT_TEXT_FORMAT',
		});
		expect(await read('application/pdf', pngBytes())).toMatchObject({
			status: 'unsupported',
			reason: 'DOCUMENT_TEXT_UNREADABLE',
		});
		expect(
			await read('application/pdf', Buffer.from('%PDF-1.7\nnot a pdf\n')),
		).toMatchObject({ reason: 'DOCUMENT_TEXT_UNREADABLE' });
	});

	it('DOCUMENTS-TEXT-OCR answers a PDF without a text layer and an image as needing OCR', async () => {
		expect(await read('application/pdf', pdfDocument([null, null]))).toEqual({
			kind: 'scan',
			pageCount: 2,
		});
		expect(await read('image/png', pngBytes())).toEqual({
			kind: 'scan',
			pageCount: 1,
		});
	});

	it('DOCUMENTS-TEXT-BOUNDS refuses input over the input bound before a parser runs', async () => {
		expect(
			await read('application/pdf', pdfDocument(['x']), { inputBytes: 100 }),
		).toEqual({
			kind: 'refused',
			status: 'too-large',
			reason: 'DOCUMENT_TEXT_TOO_LARGE',
		});
	});

	it('DOCUMENTS-TEXT-BOUNDS keeps at most the page bound and marks the rest truncated', async () => {
		const pages = Array.from({ length: 7 }, (_, index) => `Page ${index + 1}`);
		expect(
			await read('application/pdf', pdfDocument(pages), { pages: 5 }),
		).toEqual({
			kind: 'text',
			pages: pages.slice(0, 5),
			pageCount: 7,
			truncated: true,
		});
		expect(
			await read('application/pdf', pdfDocument(pages.slice(0, 5)), {
				pages: 5,
			}),
		).toMatchObject({ truncated: false, pageCount: 5 });
	});

	it('DOCUMENTS-TEXT-BOUNDS cuts text past the byte bound at a character and flow pages at line ends', async () => {
		const text = new TextEncoder().encode(
			'żółw\n'.repeat(30) /* 6 characters, 8 bytes a line */,
		);
		const read64 = await read('text/plain', text, {
			textBytes: 64,
			flowPageCharacters: 20,
		});
		expect(read64).toMatchObject({ kind: 'text', truncated: true });
		const pages = (read64 as unknown as { pages: string[] }).pages;
		expect(Buffer.byteLength(pages.join(''), 'utf8')).toBeLessThanOrEqual(64);
		expect(pages.every((page) => page.length <= 20)).toBe(true);
		expect(pages).toEqual(['żółw\nżółw\nżółw\nżółw', 'żółw\nżółw\nżółw\nżółw']);
	});

	it('DOCUMENTS-TEXT-BOUNDS cuts a line longer than a flow page at the page bound', async () => {
		const long = new TextEncoder().encode('a'.repeat(45));
		expect(
			await read('text/plain', long, { flowPageCharacters: 20 }),
		).toMatchObject({
			pages: ['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(5)],
			pageCount: 3,
			truncated: false,
		});
	});

	it('DOCUMENTS-TEXT-BOUNDS stops a part at the inflation bound however large it claims to be', async () => {
		const bomb = docxBytes(paragraph('x'.repeat(200_000)));
		expect(bomb.byteLength).toBeLessThan(4_096);
		const answer = await read(DOCX_TYPE, bomb, { inflatedBytes: 50_000 });
		expect(answer).toMatchObject({ kind: 'text', truncated: true });
		const inflated = (answer as unknown as { pages: string[] }).pages.join('');
		expect(inflated.length).toBeLessThan(50_000);
		expect(inflated.length).toBeGreaterThan(40_000);
		expect(inflated).toMatch(/^x+$/);
	});

	it('DOCUMENTS-TEXT-SAFETY never reads a DTD or expands an entity', async () => {
		const internal = docxBytes('<w:p><w:r><w:t>&xxe;</w:t></w:r></w:p>', {
			prolog: '<!DOCTYPE w:document [<!ENTITY xxe "expanded">]>',
		});
		expect(await read(DOCX_TYPE, internal)).toEqual({
			kind: 'refused',
			status: 'unsupported',
			reason: 'DOCUMENT_TEXT_UNREADABLE',
		});
		const external = docxBytes('<w:p><w:r><w:t>&xxe;</w:t></w:r></w:p>', {
			prolog:
				'<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
		});
		expect(await read(DOCX_TYPE, external)).toMatchObject({
			reason: 'DOCUMENT_TEXT_UNREADABLE',
		});
		const undeclared = docxBytes('<w:p><w:r><w:t>&nbsp;</w:t></w:r></w:p>');
		expect(await read(DOCX_TYPE, undeclared)).toMatchObject({
			reason: 'DOCUMENT_TEXT_UNREADABLE',
		});
		/* A declaration alone is refused too, so no reference can ever meet it. */
		const declaredOnly = docxBytes('<w:p><w:r><w:t>plain</w:t></w:r></w:p>', {
			prolog: '<!DOCTYPE w:document [<!ENTITY xxe "expanded">]>',
		});
		expect(await read(DOCX_TYPE, declaredOnly)).toMatchObject({
			reason: 'DOCUMENT_TEXT_UNREADABLE',
		});
		expect(
			await read(
				DOCX_TYPE,
				docxBytes('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>'),
			),
		).toMatchObject({ kind: 'text', pages: ['a & b'] });
	});

	it('DOCUMENTS-TEXT-SAFETY answers a password protected PDF as encrypted', async () => {
		expect(await read('application/pdf', encryptedPdf())).toEqual({
			kind: 'refused',
			status: 'unsupported',
			reason: 'DOCUMENT_TEXT_ENCRYPTED',
		});
	});

	it('DOCUMENTS-TEXT-SAFETY refuses encrypted entries, other compression methods, duplicate names and a broken directory', async () => {
		const types = { name: '[Content_Types].xml', data: '<Types/>' };
		const document = {
			name: 'word/document.xml',
			data: '<w:document><w:body/></w:document>',
		};
		for (const archive of [
			zipBytes([types, { ...document, encrypted: true }]),
			zipBytes([types, { ...document, method: 12 }]),
			zipBytes([types, document, document]),
			zipBytes([types, document]).subarray(0, 60),
		]) {
			expect(await read(DOCX_TYPE, archive)).toMatchObject({
				kind: 'refused',
				reason: 'DOCUMENT_TEXT_UNREADABLE',
			});
		}
	});
});
