/* The platform stores content it did not produce, so the declared type is not
   evidence. Every accepted type is verified against the bytes: a signature, or a
   structural check for the container formats that share one. Archives and
   executables are absent by decision, not by oversight. */

const OOXML_ENTRY = '[Content_Types].xml';
const TEXT_SAMPLE_BYTES = 64 * 1024;

type ContentVerifier = (body: Uint8Array) => boolean;

function signature(...bytes: readonly number[]): ContentVerifier {
	return (body) => {
		if (body.byteLength < bytes.length) return false;
		return bytes.every((value, index) => body[index] === value);
	};
}

function at(offset: number, text: string): ContentVerifier {
	const codes = [...text].map((character) => character.charCodeAt(0));
	return (body) => {
		if (body.byteLength < offset + codes.length) return false;
		return codes.every((value, index) => body[offset + index] === value);
	};
}

function either(...verifiers: readonly ContentVerifier[]): ContentVerifier {
	return (body) => verifiers.some((verify) => verify(body));
}

function both(...verifiers: readonly ContentVerifier[]): ContentVerifier {
	return (body) => verifiers.every((verify) => verify(body));
}

/**
 * An OOXML document is a ZIP whose first entry is the content type map. A plain
 * archive renamed to .docx carries a different first entry, so this refuses the
 * archive the allowlist deliberately leaves out.
 */
const ooxml: ContentVerifier = (body) => {
	if (!signature(0x50, 0x4b, 0x03, 0x04)(body)) return false;
	if (body.byteLength < 30) return false;
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	const nameLength = view.getUint16(26, true);
	if (nameLength !== OOXML_ENTRY.length) return false;
	if (body.byteLength < 30 + nameLength) return false;
	return at(30, OOXML_ENTRY)(body);
};

/* Valid UTF-8 without NUL or stray control bytes. The decoder runs over a
   bounded prefix in streaming mode, so a multi-byte sequence split by the
   sample boundary is not read as a failure. */
const utf8Text: ContentVerifier = (body) => {
	const sample = body.subarray(0, TEXT_SAMPLE_BYTES);
	for (const byte of sample) {
		if (byte === 0) return false;
		if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
		return true;
	} catch {
		return false;
	}
};

/* Documents, images, spreadsheets and PDF. No archive and no executable: a type
   added here needs a verifier that a renamed file cannot satisfy. */
const RULES: ReadonlyMap<string, ContentVerifier> = new Map([
	['application/pdf', signature(0x25, 0x50, 0x44, 0x46, 0x2d)],
	['image/png', signature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
	['image/jpeg', signature(0xff, 0xd8, 0xff)],
	['image/gif', either(at(0, 'GIF87a'), at(0, 'GIF89a'))],
	['image/webp', both(at(0, 'RIFF'), at(8, 'WEBP'))],
	['text/plain', utf8Text],
	['text/csv', utf8Text],
	[
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		ooxml,
	],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ooxml],
	[
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		ooxml,
	],
	[
		'application/msword',
		signature(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
	],
	[
		'application/vnd.ms-excel',
		signature(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
	],
]);

/** Every content type an object may be stored under. */
export const STORAGE_CONTENT_TYPES: readonly string[] = Object.freeze([
	...RULES.keys(),
]);

/**
 * The essence of a media type: lowercased, without parameters and without
 * surrounding space. `null` when the value is not a media type at all.
 */
export function normalizeContentType(value: string): string | null {
	const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
		essence,
	)
		? essence
		: null;
}

export function contentTypeAllowed(contentType: string): boolean {
	return RULES.has(contentType);
}

/** Whether the bytes carry what the normalized content type claims. */
export function contentMatchesType(
	contentType: string,
	body: Uint8Array,
): boolean {
	const verify = RULES.get(contentType);
	return verify ? verify(body) : false;
}
