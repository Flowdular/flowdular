import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodingAgentTool } from '@flowdular/coding-agent';
import { MAX_ATTACHMENT_BYTES } from './attachments.ts';
import type { SessionAttachment } from './sessions.ts';
import { SandboxSetupError } from './workspace-root.ts';

export const SAMPLE_DATA_TOOL = 'sample-data';
export const SAMPLE_DATA_ROWS = 20;
export const SAMPLE_DATA_REFERENCE = 'reference/sample-data.json';
const MAX_COLUMNS = 40;
const MAX_CELL = 200;
const MAX_JSON_DEPTH = 4;
export const MAX_SAMPLE_PREVIEW_BYTES = 32 * 1024;
export const MAX_SAMPLE_LISTING_BYTES = 64 * 1024;

export type SampleDataFormat = 'csv' | 'json' | 'text';

const FORMATS: Readonly<Record<string, SampleDataFormat>> = {
	csv: 'csv',
	json: 'json',
	txt: 'text',
};

export interface SampleDataPreview {
	readonly name: string;
	readonly format: SampleDataFormat;
	readonly size: number;
	/* Data rows without the CSV header, items of the JSON collection, or lines. */
	readonly rowCount: number;
	readonly columns: readonly string[];
	readonly rows: readonly unknown[];
	/* True when a row, column or value was left out of the preview. */
	readonly truncated: boolean;
	readonly delimiter?: string;
	/* Where the JSON rows came from: `$` for a top-level array, `$.key` otherwise. */
	readonly path?: string;
	readonly note?: string;
	readonly error?: string;
}

export interface SampleDataListing {
	readonly sampleData: readonly SampleDataPreview[];
}

export function sampleDataFormat(name: string): SampleDataFormat | null {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? (FORMATS[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

export function sampleDataAttachments(
	attachments: readonly SessionAttachment[],
): readonly SessionAttachment[] {
	return attachments.filter(
		(item) => item.kind === 'file' && sampleDataFormat(item.name) !== null,
	);
}

function cell(value: string): { value: string; cut: boolean } {
	return value.length > MAX_CELL
		? { value: `${value.slice(0, MAX_CELL)}...`, cut: true }
		: { value, cut: false };
}

function delimiterOf(text: string): string {
	const counts = new Map([
		[',', 0],
		[';', 0],
		['\t', 0],
	]);
	let quoted = false;
	for (const character of text) {
		if (character === '"') quoted = !quoted;
		else if (!quoted && (character === '\n' || character === '\r')) break;
		else if (!quoted && counts.has(character))
			counts.set(character, counts.get(character)! + 1);
	}
	let best = ',';
	for (const [candidate, count] of counts)
		if (count > counts.get(best)!) best = candidate;
	return best;
}

/* RFC 4180 with a detected delimiter: quoted fields may hold delimiters, line
   breaks and doubled quotes. Every record is counted; only the header and the
   first rows are kept. */
function previewCsv(
	text: string,
): Pick<
	SampleDataPreview,
	'rowCount' | 'columns' | 'rows' | 'truncated' | 'delimiter'
> {
	const delimiter = delimiterOf(text);
	const kept: string[][] = [];
	let records = 0;
	let record: string[] = [];
	let field = '';
	let quoted = false;
	let truncated = false;
	const endField = () => {
		record.push(field);
		field = '';
	};
	const endRecord = () => {
		endField();
		const blank = record.length === 1 && record[0] === '';
		if (!blank) {
			if (kept.length <= SAMPLE_DATA_ROWS) kept.push(record);
			records += 1;
		}
		record = [];
	};
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (quoted) {
			if (character !== '"') field += character;
			else if (text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else quoted = false;
			continue;
		}
		if (character === '"' && field === '') quoted = true;
		else if (character === delimiter) endField();
		else if (character === '\n') endRecord();
		else if (character !== '\r') field += character;
	}
	if (field !== '' || record.length > 0) endRecord();
	const bound = (values: readonly string[]) => {
		if (values.length > MAX_COLUMNS) truncated = true;
		return values.slice(0, MAX_COLUMNS).map((value) => {
			const bounded = cell(value);
			if (bounded.cut) truncated = true;
			return bounded.value;
		});
	};
	const [header = [], ...rows] = kept;
	const rowCount = Math.max(0, records - 1);
	if (rowCount > rows.length) truncated = true;
	return {
		delimiter,
		columns: bound(header),
		rows: rows.map(bound),
		rowCount,
		truncated,
	};
}

function boundJson(
	value: unknown,
	depth: number,
	flag: { truncated: boolean },
): unknown {
	if (typeof value === 'string') {
		const bounded = cell(value);
		if (bounded.cut) flag.truncated = true;
		return bounded.value;
	}
	if (value === null || typeof value !== 'object') return value;
	if (depth >= MAX_JSON_DEPTH) {
		flag.truncated = true;
		return Array.isArray(value) ? '[array]' : '[object]';
	}
	if (Array.isArray(value)) {
		if (value.length > SAMPLE_DATA_ROWS) flag.truncated = true;
		return value
			.slice(0, SAMPLE_DATA_ROWS)
			.map((item) => boundJson(item, depth + 1, flag));
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_COLUMNS) flag.truncated = true;
	return Object.fromEntries(
		entries
			.slice(0, MAX_COLUMNS)
			.map(([key, item]) => [key, boundJson(item, depth + 1, flag)]),
	);
}

function previewJson(
	text: string,
): Pick<
	SampleDataPreview,
	'rowCount' | 'columns' | 'rows' | 'truncated' | 'path' | 'error'
> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			rowCount: 0,
			columns: [],
			rows: [],
			truncated: false,
			error: `The file is not valid JSON: ${(error as Error).message.slice(0, 200)}`,
		};
	}
	let path = '$';
	let collection: readonly unknown[] = [parsed];
	if (Array.isArray(parsed)) collection = parsed;
	else if (parsed && typeof parsed === 'object') {
		const found = Object.entries(parsed).find(([, value]) =>
			Array.isArray(value),
		);
		if (found) {
			path = `$.${found[0]}`;
			collection = found[1] as unknown[];
		}
	}
	const flag = { truncated: collection.length > SAMPLE_DATA_ROWS };
	const items = collection.slice(0, SAMPLE_DATA_ROWS);
	const columns = new Set<string>();
	for (const item of items) {
		if (item && typeof item === 'object' && !Array.isArray(item))
			for (const key of Object.keys(item)) columns.add(key);
	}
	if (columns.size > MAX_COLUMNS) flag.truncated = true;
	return {
		path,
		rowCount: collection.length,
		columns: [...columns]
			.slice(0, MAX_COLUMNS)
			.map((column) => cell(column).value),
		rows: items.map((item) => boundJson(item, 1, flag)),
		truncated: flag.truncated,
	};
}

function previewText(
	text: string,
): Pick<SampleDataPreview, 'rowCount' | 'columns' | 'rows' | 'truncated'> {
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === '') lines.pop();
	let truncated = lines.length > SAMPLE_DATA_ROWS;
	return {
		rowCount: lines.length,
		columns: [],
		rows: lines.slice(0, SAMPLE_DATA_ROWS).map((line) => {
			const bounded = cell(line);
			if (bounded.cut) truncated = true;
			return bounded.value;
		}),
		truncated,
	};
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/* A preview stays under its byte budget by dropping trailing rows, so a wide
   file still answers with its columns and as many rows as fit. */
export function previewSampleData(
	name: string,
	text: string,
): SampleDataPreview {
	const format = sampleDataFormat(name);
	if (!format) {
		throw new SandboxSetupError(
			'SAMPLE_DATA_NOT_FOUND',
			`${name} is not a CSV, JSON or text attachment.`,
		);
	}
	const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
	const parsed =
		format === 'csv'
			? previewCsv(source)
			: format === 'json'
				? previewJson(source)
				: previewText(source);
	const preview: SampleDataPreview = {
		name,
		format,
		size: Buffer.byteLength(text, 'utf8'),
		...parsed,
	};
	const rows = [...preview.rows];
	let bounded = preview;
	while (rows.length > 0 && byteLength(bounded) > MAX_SAMPLE_PREVIEW_BYTES) {
		rows.pop();
		bounded = { ...preview, rows: [...rows], truncated: true };
	}
	return bounded;
}

/* Reads the turn snapshot under reference/attachments, never the private store,
   so the tool answers what the agent can already open and nothing newer. */
async function readSnapshot(
	workspace: string,
	attachment: SessionAttachment,
): Promise<string> {
	const path = join(workspace, 'reference', 'attachments', attachment.name);
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile() || info.size > MAX_ATTACHMENT_BYTES) {
		throw new SandboxSetupError(
			'SAMPLE_DATA_NOT_FOUND',
			`${attachment.name} is not available in this turn.`,
		);
	}
	return readFile(path, 'utf8');
}

export async function readSampleData(
	workspace: string,
	attachments: readonly SessionAttachment[],
	name?: string,
): Promise<SampleDataListing> {
	const available = sampleDataAttachments(attachments);
	if (name !== undefined) {
		const attachment = available.find((item) => item.name === name);
		if (!attachment) {
			throw new SandboxSetupError(
				'SAMPLE_DATA_NOT_FOUND',
				`No sample data named ${name.slice(0, 128)}. Available: ${available.map((item) => item.name).join(', ') || 'none'}.`,
			);
		}
		return {
			sampleData: [
				previewSampleData(
					attachment.name,
					await readSnapshot(workspace, attachment),
				),
			],
		};
	}
	const sampleData: SampleDataPreview[] = [];
	let used = 0;
	for (const attachment of available) {
		const preview = previewSampleData(
			attachment.name,
			await readSnapshot(workspace, attachment),
		);
		const size = byteLength(preview);
		if (used + size <= MAX_SAMPLE_LISTING_BYTES) {
			sampleData.push(preview);
			used += size;
			continue;
		}
		const summary: SampleDataPreview = {
			...preview,
			rows: [],
			truncated: true,
			note: `Rows left out to keep the listing small. Call ${SAMPLE_DATA_TOOL} with this name to read them.`,
		};
		sampleData.push(summary);
		used += byteLength(summary);
	}
	return { sampleData };
}

export function sampleDataTool(
	workspace: string,
	attachments: readonly SessionAttachment[],
): CodingAgentTool {
	return {
		name: SAMPLE_DATA_TOOL,
		description: `Read-only. Lists the CSV, JSON and text files the operator attached as sample data, each with its columns and a parsed preview of the first ${SAMPLE_DATA_ROWS} rows. Pass name to preview one file.`,
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					maxLength: 128,
					description: 'One sample data file name.',
				},
			},
			additionalProperties: false,
		},
		execute: async (input) =>
			JSON.stringify(
				await readSampleData(
					workspace,
					attachments,
					typeof input.name === 'string' ? input.name : undefined,
				),
			),
	};
}

/* Local CLI drivers have no channel for a lent tool, so the same listing is left
   in the read-only reference tree of the turn, and removed when nothing is
   attached. It stays inside the session workspace. */
export async function materializeSampleData(
	workspace: string,
	attachments: readonly SessionAttachment[],
): Promise<boolean> {
	const path = join(workspace, SAMPLE_DATA_REFERENCE);
	await rm(path, { force: true });
	if (sampleDataAttachments(attachments).length === 0) return false;
	await writeFile(
		path,
		`${JSON.stringify(await readSampleData(workspace, attachments), null, 2)}\n`,
		{ flag: 'wx' },
	);
	return true;
}

export function sampleDataInstruction(
	attachments: readonly SessionAttachment[],
): string | null {
	const names = sampleDataAttachments(attachments).map((item) => item.name);
	if (names.length === 0) return null;
	return `Sample data: ${names.join(', ')}. Call the ${SAMPLE_DATA_TOOL} tool, or read ${SAMPLE_DATA_REFERENCE}, for the columns and the first ${SAMPLE_DATA_ROWS} rows. Build the entities, tests/fixtures/*.json and preview/seed.json from its shape; replace real names, contacts and identifiers with invented values, because fixtures ship with the module and the sample itself never leaves this session.`;
}
