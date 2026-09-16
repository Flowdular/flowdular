import { posix } from 'node:path';
import type { PageWriter } from './pages.ts';
import { readXml, relationshipId, type XmlHandlers } from './xml.ts';
import { ZipUnreadable, type ZipPackage } from './zip.ts';

interface Relationship {
	readonly id: string;
	readonly type: string;
	readonly target: string;
}

/* Excel's own ceiling; a cell reference past it is appended rather than padded
   to, so one crafted reference cannot turn a row into a run of tabs. */
const MAX_COLUMNS = 16_384;

function relsPath(part: string): string {
	return posix.join(
		posix.dirname(part),
		'_rels',
		posix.basename(part) + '.rels',
	);
}

function resolveTarget(part: string, target: string): string {
	if (target.startsWith('/')) return posix.normalize(target.slice(1));
	return posix.normalize(posix.join(posix.dirname(part), target));
}

async function part(
	zip: ZipPackage,
	name: string,
	handlers: XmlHandlers,
	writer: PageWriter,
): Promise<void> {
	await readXml(zip.read(name), handlers, () => writer.full || zip.exhausted);
	if (zip.exhausted) writer.cut();
}

async function relationships(
	zip: ZipPackage,
	owner: string,
	writer: PageWriter,
): Promise<readonly Relationship[]> {
	const path = relsPath(owner);
	if (!zip.has(path)) return [];
	const found: Relationship[] = [];
	await part(
		zip,
		path,
		{
			open(name, attributes) {
				if (name !== 'Relationship' || attributes.TargetMode === 'External') {
					return;
				}
				if (attributes.Id && attributes.Target) {
					found.push({
						id: attributes.Id,
						type: attributes.Type ?? '',
						target: resolveTarget(owner, attributes.Target),
					});
				}
			},
		},
		writer,
	);
	return found;
}

async function mainPart(
	zip: ZipPackage,
	fallback: string,
	writer: PageWriter,
): Promise<string> {
	const root = zip.has('_rels/.rels')
		? (await relationships(zip, '', writer)).find((relationship) =>
				relationship.type.endsWith('/officeDocument'),
			)?.target
		: undefined;
	const name = root ?? fallback;
	if (!zip.has(name)) throw new ZipUnreadable('The main part is missing.');
	return name;
}

/* Alternate content repeats a drawing's text for older readers; only the
   choice is read, so a text box is not answered twice. */
function fallbackDepth() {
	let depth = 0;
	return {
		open(name: string): void {
			if (name === 'Fallback') depth += 1;
		},
		close(name: string): void {
			if (name === 'Fallback') depth -= 1;
		},
		get inside(): boolean {
			return depth > 0;
		},
	};
}

export async function readDocx(
	zip: ZipPackage,
	writer: PageWriter,
): Promise<void> {
	const document = await mainPart(zip, 'word/document.xml', writer);
	const fallback = fallbackDepth();
	let inText = 0;
	let inTabs = 0;
	writer.startPage();
	await part(
		zip,
		document,
		{
			open(name) {
				fallback.open(name);
				if (fallback.inside) return;
				if (name === 't') inText += 1;
				else if (name === 'tabs') inTabs += 1;
				else if (name === 'tab' && inTabs === 0) writer.write('\t');
				else if (name === 'br' || name === 'cr') writer.write('\n');
			},
			close(name) {
				fallback.close(name);
				if (fallback.inside) return;
				if (name === 't') inText -= 1;
				else if (name === 'tabs') inTabs -= 1;
				else if (name === 'p') writer.write('\n');
			},
			text(text) {
				if (inText > 0 && !fallback.inside) writer.write(text);
			},
		},
		writer,
	);
}

export async function readPptx(
	zip: ZipPackage,
	writer: PageWriter,
): Promise<void> {
	const presentation = await mainPart(zip, 'ppt/presentation.xml', writer);
	const slideIds: string[] = [];
	await part(
		zip,
		presentation,
		{
			open(name, attributes) {
				const id = name === 'sldId' ? relationshipId(attributes) : null;
				if (id) slideIds.push(id);
			},
		},
		writer,
	);
	const targets = new Map(
		(await relationships(zip, presentation, writer)).map((relationship) => [
			relationship.id,
			relationship.target,
		]),
	);
	for (const id of slideIds) {
		if (writer.full) return;
		const slide = targets.get(id);
		writer.startPage();
		if (!slide || !zip.has(slide)) continue;
		const fallback = fallbackDepth();
		let inText = 0;
		await part(
			zip,
			slide,
			{
				open(name) {
					fallback.open(name);
					if (fallback.inside) return;
					if (name === 't') inText += 1;
					else if (name === 'br') writer.write('\n');
				},
				close(name) {
					fallback.close(name);
					if (fallback.inside) return;
					if (name === 't') inText -= 1;
					else if (name === 'p') writer.write('\n');
				},
				text(text) {
					if (inText > 0 && !fallback.inside) writer.write(text);
				},
			},
			writer,
		);
	}
}

function columnOf(reference: string | undefined): number | null {
	const letters = /^([A-Z]{1,3})\d+$/.exec(reference ?? '')?.[1];
	if (!letters) return null;
	let column = 0;
	for (const letter of letters)
		column = column * 26 + (letter.charCodeAt(0) - 64);
	return column <= MAX_COLUMNS ? column : null;
}

function cellText(value: string): string {
	return value.replace(/[\t\r\n]+/g, ' ');
}

export async function readXlsx(
	zip: ZipPackage,
	writer: PageWriter,
): Promise<void> {
	const workbook = await mainPart(zip, 'xl/workbook.xml', writer);
	const sheets: { readonly name: string; readonly id: string }[] = [];
	await part(
		zip,
		workbook,
		{
			open(name, attributes) {
				const id = name === 'sheet' ? relationshipId(attributes) : null;
				if (id) sheets.push({ name: attributes.name ?? '', id });
			},
		},
		writer,
	);
	const related = await relationships(zip, workbook, writer);
	const shared = await sharedStrings(zip, related, writer);
	const worksheets = new Map(
		related
			.filter((relationship) => relationship.type.endsWith('/worksheet'))
			.map((relationship) => [relationship.id, relationship.target]),
	);
	for (const sheet of sheets) {
		if (writer.full) return;
		const path = worksheets.get(sheet.id);
		if (!path || !zip.has(path)) continue;
		writer.startPage();
		writer.write(cellText(sheet.name) + '\n');
		let cells: string[] = [];
		let column = 0;
		let type = 'n';
		let value = '';
		let inValue = 0;
		let inInline = 0;
		let inInlineText = 0;
		let inPhonetic = 0;
		await part(
			zip,
			path,
			{
				open(name, attributes) {
					if (name === 'row') {
						cells = [];
					} else if (name === 'c') {
						column = columnOf(attributes.r) ?? cells.length + 1;
						type = attributes.t ?? 'n';
						value = '';
					} else if (name === 'v') inValue += 1;
					else if (name === 'is') inInline += 1;
					else if (name === 't') inInlineText += 1;
					else if (name === 'rPh') inPhonetic += 1;
				},
				close(name) {
					if (name === 'v') inValue -= 1;
					else if (name === 'is') inInline -= 1;
					else if (name === 't') inInlineText -= 1;
					else if (name === 'rPh') inPhonetic -= 1;
					else if (name === 'c') {
						const text =
							type === 's'
								? (shared[Number.parseInt(value, 10)] ?? '')
								: type === 'b'
									? value.trim() === '1'
										? 'TRUE'
										: 'FALSE'
									: value;
						while (cells.length < column - 1) cells.push('');
						cells.push(cellText(text));
					} else if (name === 'row' && cells.length > 0) {
						writer.write(cells.join('\t') + '\n');
					}
				},
				text(text) {
					if (
						inValue > 0 ||
						(inInline > 0 && inInlineText > 0 && inPhonetic === 0)
					) {
						value += text;
					}
				},
			},
			writer,
		);
	}
}

async function sharedStrings(
	zip: ZipPackage,
	related: readonly Relationship[],
	writer: PageWriter,
): Promise<readonly string[]> {
	const path =
		related.find((relationship) => relationship.type.endsWith('/sharedStrings'))
			?.target ?? 'xl/sharedStrings.xml';
	if (!zip.has(path)) return [];
	const strings: string[] = [];
	let current = '';
	let inString = 0;
	let inText = 0;
	let inPhonetic = 0;
	await part(
		zip,
		path,
		{
			open(name) {
				if (name === 'si') {
					inString += 1;
					current = '';
				} else if (name === 't') inText += 1;
				else if (name === 'rPh') inPhonetic += 1;
			},
			close(name) {
				if (name === 'si') {
					inString -= 1;
					strings.push(current);
				} else if (name === 't') inText -= 1;
				else if (name === 'rPh') inPhonetic -= 1;
			},
			text(text) {
				if (inString > 0 && inText > 0 && inPhonetic === 0) current += text;
			},
		},
		writer,
	);
	return strings;
}
