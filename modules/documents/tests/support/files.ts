import { INFECTED_MARKER } from './storage.ts';

/* The port verifies the declared type against the bytes, so a fixture has to
   carry the real signature of what it claims to be. */

export function pdfBytes(body = 'documents test'): Uint8Array {
	return Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, 'latin1');
}

export function infectedPdfBytes(): Uint8Array {
	return pdfBytes(INFECTED_MARKER);
}

export function pngBytes(): Uint8Array {
	return Buffer.concat([
		Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		Buffer.from('documents test png', 'latin1'),
	]);
}

/** An ELF header: the allowlist has no executable, so the type is refused. */
export function executableBytes(): Uint8Array {
	return Buffer.concat([
		Buffer.of(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01),
		Buffer.from('documents test binary', 'latin1'),
	]);
}

export function textBytes(size: number): Uint8Array {
	return Buffer.alloc(size, 0x61);
}
