import { crc32, deflateRawSync } from 'node:zlib';

/* Every fixture here is built by the test from literal text, so no document of
   anyone else's is committed and each case shows exactly what it feeds in. */

export const DOCX_TYPE =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_TYPE =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_TYPE =
	'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface ZipEntryInput {
	readonly name: string;
	readonly data: string | Uint8Array;
	/** 0 stored, 8 deflate; anything else is written as is, uncompressed. */
	readonly method?: number;
	readonly encrypted?: boolean;
}

/** A plain ZIP writer: local headers, the central directory and its end record. */
export function zipBytes(entries: readonly ZipEntryInput[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const raw = Buffer.from(
			typeof entry.data === 'string'
				? Buffer.from(entry.data, 'utf8')
				: entry.data,
		);
		const method = entry.method ?? 8;
		const stored = method === 8 ? deflateRawSync(raw) : raw;
		const name = Buffer.from(entry.name, 'utf8');
		const flags = (entry.encrypted ? 0x0001 : 0) | 0x0800;
		const checksum = crc32(raw);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0x21, 12);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(stored.byteLength, 18);
		local.writeUInt32LE(raw.byteLength, 22);
		local.writeUInt16LE(name.byteLength, 26);
		locals.push(local, name, stored);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(0x21, 14);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(stored.byteLength, 20);
		central.writeUInt32LE(raw.byteLength, 24);
		central.writeUInt16LE(name.byteLength, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.byteLength + name.byteLength + stored.byteLength;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.byteLength, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;

const RELATIONSHIPS =
	'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE =
	'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function rels(
	entries: readonly {
		readonly id: string;
		readonly type: string;
		readonly target: string;
	}[],
): string {
	return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELATIONSHIPS}">${entries
		.map(
			(entry) =>
				`<Relationship Id="${entry.id}" Type="${OFFICE}/${entry.type}" Target="${entry.target}"/>`,
		)
		.join('')}</Relationships>`;
}

function ooxml(
	main: string,
	parts: readonly ZipEntryInput[],
	method = 8,
): Uint8Array {
	return zipBytes([
		{ name: '[Content_Types].xml', data: CONTENT_TYPES, method },
		{
			name: '_rels/.rels',
			data: rels([{ id: 'rId1', type: 'officeDocument', target: main }]),
			method,
		},
		...parts.map((part) => ({ method, ...part })),
	]);
}

const W =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function docxBytes(
	body: string,
	options: { readonly prolog?: string; readonly method?: number } = {},
): Uint8Array {
	return ooxml(
		'word/document.xml',
		[
			{
				name: 'word/document.xml',
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${options.prolog ?? ''}<w:document ${W}><w:body>${body}</w:body></w:document>`,
			},
		],
		options.method ?? 8,
	);
}

/** A paragraph of runs; `\t` becomes a tab element and `\n` a break. */
export function paragraph(text: string): string {
	const runs = text
		.split(/(\t|\n)/)
		.map((piece) =>
			piece === '\t'
				? '<w:r><w:tab/></w:r>'
				: piece === '\n'
					? '<w:r><w:br/></w:r>'
					: piece === ''
						? ''
						: `<w:r><w:t xml:space="preserve">${piece
								.replace(/&/g, '&amp;')
								.replace(/</g, '&lt;')}</w:t></w:r>`,
		)
		.join('');
	return `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs}</w:p>`;
}

export interface SheetInput {
	readonly name: string;
	/** Raw `<row>` markup. */
	readonly rows: string;
}

export function xlsxBytes(
	sheets: readonly SheetInput[],
	sharedStrings: string,
): Uint8Array {
	const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
	const R = `xmlns:r="${OFFICE}"`;
	return ooxml('xl/workbook.xml', [
		{
			name: 'xl/workbook.xml',
			data: `<?xml version="1.0" encoding="UTF-8"?><workbook ${S} ${R}><sheets>${sheets
				.map(
					(sheet, index) =>
						`<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
				)
				.join('')}</sheets></workbook>`,
		},
		{
			name: 'xl/_rels/workbook.xml.rels',
			data: rels([
				...sheets.map((_, index) => ({
					id: `rId${index + 1}`,
					type: 'worksheet',
					target: `worksheets/sheet${index + 1}.xml`,
				})),
				{
					id: 'rIdStrings',
					type: 'sharedStrings',
					target: 'sharedStrings.xml',
				},
			]),
		},
		{
			name: 'xl/sharedStrings.xml',
			data: `<?xml version="1.0" encoding="UTF-8"?><sst ${S}>${sharedStrings}</sst>`,
		},
		...sheets.map((sheet, index) => ({
			name: `xl/worksheets/sheet${index + 1}.xml`,
			data: `<?xml version="1.0" encoding="UTF-8"?><worksheet ${S}><sheetData>${sheet.rows}</sheetData></worksheet>`,
		})),
	]);
}

/** Slides in presentation order; the parts are written in reverse to prove the order is read. */
export function pptxBytes(slides: readonly string[]): Uint8Array {
	const P =
		'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
	const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
	const R = `xmlns:r="${OFFICE}"`;
	const count = slides.length;
	return ooxml('ppt/presentation.xml', [
		{
			name: 'ppt/presentation.xml',
			data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P} ${R}><p:sldIdLst>${slides
				.map(
					(_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
				)
				.join('')}</p:sldIdLst></p:presentation>`,
		},
		{
			name: 'ppt/_rels/presentation.xml.rels',
			data: rels(
				slides.map((_, index) => ({
					id: `rId${index + 1}`,
					type: 'slide',
					target: `slides/slide${count - index}.xml`,
				})),
			),
		},
		...slides.map((paragraphs, index) => ({
			name: `ppt/slides/slide${count - index}.xml`,
			data: `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		})),
	]);
}

function pdfString(text: string): string {
	return text.replace(/[\\()]/g, (character) => '\\' + character);
}

/**
 * A minimal PDF: one Helvetica text line per page, or a drawn line for a page
 * given as null, which has no text layer.
 */
export function pdfDocument(
	pages: readonly (string | null)[],
	trailer = '',
): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => objects.push(body);
	add('<< /Type /Catalog /Pages 2 0 R >>');
	add('');
	add(
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
	);
	const kids: number[] = [];
	for (const text of pages) {
		const stream =
			text === null
				? '0 0 m 100 100 l S'
				: `BT /F1 12 Tf 72 720 Td (${pdfString(text)}) Tj ET`;
		add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		const content = objects.length;
		add(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`,
		);
		kids.push(objects.length);
	}
	objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`;
	let out = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	out += offsets
		.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)
		.join('');
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** A standard security handler whose empty user password does not open the file. */
export function encryptedPdf(): Uint8Array {
	return pdfDocument(
		['secret'],
		`/Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >> /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>] `,
	);
}
