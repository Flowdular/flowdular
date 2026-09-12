/** Why a control refused a file. The words for it belong to the screen. */
export type FileRefusalReason = 'type' | 'size';

/** What a refusal check reads: a `File` satisfies it, and so does a test. */
export interface FileFacts {
	readonly name: string;
	readonly type: string;
	readonly size: number;
}

function matchesEntry(file: FileFacts, entry: string): boolean {
	const rule = entry.trim().toLowerCase();
	if (rule === '' || rule === '*/*') return true;
	if (rule.startsWith('.')) return file.name.toLowerCase().endsWith(rule);
	const type = file.type.toLowerCase();
	if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
	return type === rule;
}

/**
 * Whether `accept` covers the file, over the same three forms the HTML
 * attribute takes: an exact content type, a `type/*` family, and a filename
 * suffix. An empty list accepts everything, because a screen that could not
 * read the port's limits must still offer the upload.
 */
export function acceptsFile(
	file: FileFacts,
	accept: readonly string[] | undefined,
): boolean {
	if (accept === undefined || accept.length === 0) return true;
	for (const entry of accept) if (matchesEntry(file, entry)) return true;
	return false;
}

/**
 * Why this file cannot be uploaded, or null when it can. The port applies the
 * same ceiling to the bytes it receives; checking here spends a comparison
 * instead of the upload. A limit the screen has not read yet is `null` and
 * refuses nothing, so the server stays the authority.
 */
export function fileRefusal(
	file: FileFacts,
	accept: readonly string[] | undefined,
	maxBytes: number | null | undefined,
): FileRefusalReason | null {
	if (!acceptsFile(file, accept)) return 'type';
	if (typeof maxBytes === 'number' && file.size > maxBytes) return 'size';
	return null;
}
