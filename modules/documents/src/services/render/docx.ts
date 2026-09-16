import type {
	RenderedBlock,
	RenderedLine,
	RenderedList,
	RenderedMarginLine,
	RenderedTemplate,
} from '../../domain/template-evaluate.ts';
import type { DocumentTemplateLayout } from '../../domain/templates.ts';
import type { DocumentRenderer, RenderOptions } from './renderer.ts';

type Docx = typeof import('docx');
type Paragraph = InstanceType<Docx['Paragraph']>;
type Table = InstanceType<Docx['Table']>;
type ParagraphChild = InstanceType<Docx['TextRun']>;

/* Twentieths of a point, the unit a WordprocessingML page is measured in. */
const PAGE_TWIPS = {
	A4: { width: 11_906, height: 16_838 },
	Letter: { width: 12_240, height: 15_840 },
} as const;
const MILLIMETRE_IN_TWIPS = 1440 / 25.4;
const ALIGNMENT = { left: 'left', center: 'center', right: 'right' } as const;

let library: Promise<Docx> | null = null;

function loadLibrary(): Promise<Docx> {
	library ??= import('docx');
	return library;
}

function textRuns(
	docx: Docx,
	line: RenderedLine,
	extra: { readonly bold?: boolean; readonly italics?: boolean } = {},
): ParagraphChild[] {
	const children: ParagraphChild[] = [];
	for (const run of line) {
		run.text.split('\n').forEach((piece, index) => {
			children.push(
				new docx.TextRun({
					text: piece,
					...(index > 0 ? { break: 1 } : {}),
					...(run.bold || extra.bold ? { bold: true } : {}),
					...(run.italic || extra.italics ? { italics: true } : {}),
					...(run.code
						? { font: 'Courier New', shading: { fill: 'EEEEEE' } }
						: {}),
				}),
			);
		});
	}
	return children;
}

interface Numbering {
	readonly reference: string;
	readonly ordered: boolean;
	readonly start: number;
}

function listParagraphs(
	docx: Docx,
	source: RenderedList,
	numberings: Numbering[],
	level: 0 | 1,
): Paragraph[] {
	const reference = `list-${numberings.length}`;
	numberings.push({ reference, ordered: source.ordered, start: source.start });
	return source.items.flatMap((item) => [
		new docx.Paragraph({
			children: textRuns(docx, item.runs),
			numbering: { reference, level },
		}),
		...(item.sublist ? listParagraphs(docx, item.sublist, numberings, 1) : []),
	]);
}

function blockElements(
	docx: Docx,
	source: RenderedBlock,
	numberings: Numbering[],
): (Paragraph | Table)[] {
	switch (source.kind) {
		case 'heading':
			return [
				new docx.Paragraph({
					heading:
						source.level === 1
							? docx.HeadingLevel.HEADING_1
							: source.level === 2
								? docx.HeadingLevel.HEADING_2
								: docx.HeadingLevel.HEADING_3,
					children: textRuns(docx, source.runs),
				}),
			];
		case 'paragraph':
			return [new docx.Paragraph({ children: textRuns(docx, source.runs) })];
		case 'list':
			return listParagraphs(docx, source, numberings, 0);
		case 'quote':
			return source.paragraphs.map(
				(paragraph) =>
					new docx.Paragraph({
						children: textRuns(docx, paragraph, { italics: true }),
						indent: { left: 567 },
						border: {
							left: {
								style: docx.BorderStyle.SINGLE,
								size: 12,
								color: 'BBBBBB',
								space: 8,
							},
						},
					}),
			);
		case 'rule':
			return [
				new docx.Paragraph({
					border: {
						bottom: {
							style: docx.BorderStyle.SINGLE,
							size: 6,
							color: '999999',
							space: 1,
						},
					},
				}),
			];
		case 'pagebreak':
			return [new docx.Paragraph({ children: [new docx.PageBreak()] })];
		case 'table': {
			const cell = (line: RenderedLine, column: number, header: boolean) =>
				new docx.TableCell({
					children: [
						new docx.Paragraph({
							alignment: ALIGNMENT[source.align[column] ?? 'left'],
							children: textRuns(docx, line, header ? { bold: true } : {}),
						}),
					],
				});
			return [
				new docx.Table({
					width: { size: 100, type: docx.WidthType.PERCENTAGE },
					rows: [
						new docx.TableRow({
							tableHeader: true,
							cantSplit: true,
							children: source.header.map((line, column) =>
								cell(line, column, true),
							),
						}),
						...source.rows.map(
							(row) =>
								new docx.TableRow({
									cantSplit: true,
									children: source.align.map((_, column) =>
										cell(row[column] ?? [], column, false),
									),
								}),
						),
					],
				}),
				new docx.Paragraph({}),
			];
		}
	}
}

function marginParagraph(docx: Docx, line: RenderedMarginLine): Paragraph {
	return new docx.Paragraph({
		children: line.map((part) =>
			typeof part === 'string'
				? new docx.TextRun({ text: part, size: 16 })
				: new docx.TextRun({
						children: [
							part.counter === 'page'
								? docx.PageNumber.CURRENT
								: docx.PageNumber.TOTAL_PAGES,
						],
						size: 16,
					}),
		),
	});
}

export const docxRenderer: DocumentRenderer = {
	format: 'docx',
	contentType:
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	extension: 'docx',
	async render(
		document: RenderedTemplate,
		layout: DocumentTemplateLayout,
		options: RenderOptions,
	): Promise<Uint8Array> {
		options.signal?.throwIfAborted();
		const docx = await loadLibrary();
		const numberings: Numbering[] = [];
		const children = document.blocks.flatMap((block) =>
			blockElements(docx, block, numberings),
		);
		const twips = (millimetres: number) =>
			Math.round(millimetres * MILLIMETRE_IN_TWIPS);
		const file = new docx.Document({
			title: document.title,
			creator: 'Flowdular',
			styles: {
				default: {
					document: { run: { font: 'Roboto', size: 20 } },
				},
			},
			numbering: {
				config: numberings.map((numbering) => ({
					reference: numbering.reference,
					levels: [0, 1].map((level) => ({
						level,
						format: numbering.ordered
							? level === 0
								? docx.LevelFormat.DECIMAL
								: docx.LevelFormat.LOWER_LETTER
							: docx.LevelFormat.BULLET,
						text: numbering.ordered
							? `%${level + 1}.`
							: level === 0
								? '•'
								: '◦',
						start: level === 0 ? numbering.start : 1,
						alignment: docx.AlignmentType.START,
						style: {
							paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
						},
					})),
				})),
			},
			sections: [
				{
					properties: {
						page: {
							size: PAGE_TWIPS[layout.pageSize],
							margin: {
								top: twips(layout.margins.top),
								right: twips(layout.margins.right),
								bottom: twips(layout.margins.bottom),
								left: twips(layout.margins.left),
								header: twips(Math.min(layout.margins.top / 2, 12)),
								footer: twips(Math.min(layout.margins.bottom / 2, 12)),
							},
						},
					},
					...(document.header
						? {
								headers: {
									default: new docx.Header({
										children: [marginParagraph(docx, document.header)],
									}),
								},
							}
						: {}),
					...(document.footer
						? {
								footers: {
									default: new docx.Footer({
										children: [marginParagraph(docx, document.footer)],
									}),
								},
							}
						: {}),
					children,
				},
			],
		});
		const bytes = await docx.Packer.toBuffer(file);
		options.signal?.throwIfAborted();
		return contentTypesFirst(bytes);
	},
};

const CONTENT_TYPES = '[Content_Types].xml';

/**
 * The same package with `[Content_Types].xml` as its first entry and without
 * directory entries. The storage port recognises an OOXML document by that
 * first entry, and docx writes it tenth. Every entry's compressed bytes, CRC
 * and sizes are copied as they are; only the order and the offsets change.
 */
export function contentTypesFirst(archive: Uint8Array): Uint8Array {
	const source = Buffer.from(
		archive.buffer,
		archive.byteOffset,
		archive.byteLength,
	);
	const end = source.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (end < 0) throw new Error('The DOCX package has no end record.');
	const count = source.readUInt16LE(end + 10);
	let cursor = source.readUInt32LE(end + 16);
	const entries: { name: Buffer; central: Buffer; data: Buffer }[] = [];
	for (let index = 0; index < count; index += 1) {
		const nameLength = source.readUInt16LE(cursor + 28);
		const extraLength = source.readUInt16LE(cursor + 30);
		const commentLength = source.readUInt16LE(cursor + 32);
		const name = source.subarray(cursor + 46, cursor + 46 + nameLength);
		const compressed = source.readUInt32LE(cursor + 20);
		const local = source.readUInt32LE(cursor + 42);
		const start =
			local +
			30 +
			source.readUInt16LE(local + 26) +
			source.readUInt16LE(local + 28);
		if (!name.toString('utf8').endsWith('/')) {
			entries.push({
				name,
				central: source.subarray(cursor, cursor + 46),
				data: source.subarray(start, start + compressed),
			});
		}
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	entries.sort(
		(left, right) =>
			Number(right.name.toString('utf8') === CONTENT_TYPES) -
			Number(left.name.toString('utf8') === CONTENT_TYPES),
	);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		entry.central.copy(local, 4, 6, 16);
		local.writeUInt32LE(entry.central.readUInt32LE(16), 14);
		local.writeUInt32LE(entry.central.readUInt32LE(20), 18);
		local.writeUInt32LE(entry.central.readUInt32LE(24), 22);
		local.writeUInt16LE(entry.name.length, 26);
		local.writeUInt16LE(0, 28);
		const central = Buffer.from(entry.central);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt32LE(offset, 42);
		locals.push(local, entry.name, entry.data);
		centrals.push(central, entry.name);
		offset += local.length + entry.name.length + entry.data.length;
	}
	const directory = Buffer.concat(centrals);
	const record = Buffer.alloc(22);
	record.writeUInt32LE(0x06054b50, 0);
	record.writeUInt16LE(entries.length, 8);
	record.writeUInt16LE(entries.length, 10);
	record.writeUInt32LE(directory.length, 12);
	record.writeUInt32LE(offset, 16);
	const packed = Buffer.concat([...locals, directory, record]);
	return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
}
