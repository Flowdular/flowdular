import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type FileChange = 'created' | 'modified' | 'deleted';

export interface DiffLine {
	readonly type: 'context' | 'add' | 'del';
	readonly text: string;
	readonly oldLine: number | null;
	readonly newLine: number | null;
}

export interface DiffHunk {
	readonly header: string;
	readonly lines: readonly DiffLine[];
}

export interface FileDiff {
	readonly path: string;
	readonly change: FileChange;
	readonly additions: number;
	readonly deletions: number;
	readonly binary: boolean;
	readonly truncated: boolean;
	readonly hunks: readonly DiffHunk[];
}

const IGNORED = new Set(['node_modules', 'dist', '.git']);
const MAX_DIFF_LINES = 4_000;
const CONTEXT_LINES = 3;

async function listTree(root: string, directory = root): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (IGNORED.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) files.push(...(await listTree(root, path)));
		else files.push(relative(root, path));
	}
	return files;
}

async function readIfPresent(path: string): Promise<string | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
}

/* Longest common subsequence over lines. Files above the guard are reported as
   changed without hunks so one generated lock file cannot stall the sandbox. */
function lineDiff(
	before: readonly string[],
	after: readonly string[],
): readonly DiffLine[] {
	const rows = before.length;
	const columns = after.length;
	const table: number[][] = Array.from({ length: rows + 1 }, () =>
		new Array<number>(columns + 1).fill(0),
	);
	for (let row = rows - 1; row >= 0; row -= 1) {
		for (let column = columns - 1; column >= 0; column -= 1) {
			table[row]![column] =
				before[row] === after[column]
					? table[row + 1]![column + 1]! + 1
					: Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
		}
	}
	const lines: DiffLine[] = [];
	let row = 0;
	let column = 0;
	while (row < rows && column < columns) {
		if (before[row] === after[column]) {
			lines.push({
				type: 'context',
				text: before[row]!,
				oldLine: row + 1,
				newLine: column + 1,
			});
			row += 1;
			column += 1;
		} else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
			lines.push({
				type: 'del',
				text: before[row]!,
				oldLine: row + 1,
				newLine: null,
			});
			row += 1;
		} else {
			lines.push({
				type: 'add',
				text: after[column]!,
				oldLine: null,
				newLine: column + 1,
			});
			column += 1;
		}
	}
	while (row < rows) {
		lines.push({
			type: 'del',
			text: before[row]!,
			oldLine: row + 1,
			newLine: null,
		});
		row += 1;
	}
	while (column < columns) {
		lines.push({
			type: 'add',
			text: after[column]!,
			oldLine: null,
			newLine: column + 1,
		});
		column += 1;
	}
	return lines;
}

function groupHunks(lines: readonly DiffLine[]): readonly DiffHunk[] {
	const changedIndexes = lines
		.map((line, index) => (line.type === 'context' ? -1 : index))
		.filter((index) => index >= 0);
	if (changedIndexes.length === 0) return [];

	const hunks: DiffHunk[] = [];
	let start = Math.max(0, changedIndexes[0]! - CONTEXT_LINES);
	let end = Math.min(lines.length - 1, changedIndexes[0]! + CONTEXT_LINES);
	for (const index of changedIndexes.slice(1)) {
		if (index - end <= CONTEXT_LINES * 2) {
			end = Math.min(lines.length - 1, index + CONTEXT_LINES);
			continue;
		}
		hunks.push(buildHunk(lines, start, end));
		start = Math.max(0, index - CONTEXT_LINES);
		end = Math.min(lines.length - 1, index + CONTEXT_LINES);
	}
	hunks.push(buildHunk(lines, start, end));
	return hunks;
}

function buildHunk(
	lines: readonly DiffLine[],
	start: number,
	end: number,
): DiffHunk {
	const slice = lines.slice(start, end + 1);
	const firstOld = slice.find((line) => line.oldLine !== null)?.oldLine ?? 0;
	const firstNew = slice.find((line) => line.newLine !== null)?.newLine ?? 0;
	const oldCount = slice.filter((line) => line.type !== 'add').length;
	const newCount = slice.filter((line) => line.type !== 'del').length;
	return {
		header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`,
		lines: slice,
	};
}

export async function diffFile(
	beforePath: string,
	afterPath: string,
	path: string,
): Promise<FileDiff | null> {
	const before = await readIfPresent(beforePath);
	const after = await readIfPresent(afterPath);
	if (before === null && after === null) return null;
	if (before === after) return null;

	const change: FileChange =
		before === null ? 'created' : after === null ? 'deleted' : 'modified';
	const beforeLines = before === null ? [] : before.split('\n');
	const afterLines = after === null ? [] : after.split('\n');
	const binary = [before, after].some(
		(content) => content !== null && content.includes(String.fromCharCode(0)),
	);
	const truncated =
		beforeLines.length + afterLines.length > MAX_DIFF_LINES || binary;

	if (truncated) {
		return {
			path,
			change,
			additions: afterLines.length,
			deletions: beforeLines.length,
			binary,
			truncated: true,
			hunks: [],
		};
	}
	const lines = lineDiff(beforeLines, afterLines);
	return {
		path,
		change,
		additions: lines.filter((line) => line.type === 'add').length,
		deletions: lines.filter((line) => line.type === 'del').length,
		binary: false,
		truncated: false,
		hunks: groupHunks(lines),
	};
}

export async function diffTrees(
	basePath: string,
	currentPath: string,
): Promise<readonly FileDiff[]> {
	const paths = new Set([
		...(await listTree(basePath)),
		...(await listTree(currentPath)),
	]);
	const diffs: FileDiff[] = [];
	for (const path of [...paths].sort()) {
		const diff = await diffFile(
			join(basePath, path),
			join(currentPath, path),
			path,
		);
		if (diff) diffs.push(diff);
	}
	return diffs;
}
