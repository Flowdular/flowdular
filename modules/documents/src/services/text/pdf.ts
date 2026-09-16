import { getResolvedPDFJS } from 'unpdf';
import type { PageWriter } from './pages.ts';

export class PdfEncrypted extends Error {
	constructor() {
		super('The PDF is password protected.');
		this.name = 'PdfEncrypted';
	}
}

export class PdfUnreadable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PdfUnreadable';
	}
}

/**
 * Reads the text layer page by page into the writer and answers the page count
 * the document declares. Only the text content of a page is asked for: nothing
 * renders, no font face is loaded, no WebAssembly or XFA runs, no worker starts
 * and nothing is fetched, and the bundled pdf.js carries no eval.
 */
export async function readPdf(
	bytes: Uint8Array,
	writer: PageWriter,
	signal: AbortSignal | undefined,
): Promise<number> {
	const pdfjs = await getResolvedPDFJS();
	const task = pdfjs.getDocument({
		/* pdf.js takes ownership of the buffer it is handed. */
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		disableFontFace: true,
		useWasm: false,
		useWorkerFetch: false,
		enableXfa: false,
		disableAutoFetch: true,
		disableStream: true,
		disableRange: true,
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
		stopAtErrors: false,
		verbosity: 0,
	});
	try {
		let document;
		try {
			document = await task.promise;
		} catch (error) {
			if ((error as { name?: unknown } | null)?.name === 'PasswordException') {
				throw new PdfEncrypted();
			}
			throw new PdfUnreadable('The PDF structure could not be read.');
		}
		const count = document.numPages;
		for (let number = 1; number <= count; number += 1) {
			signal?.throwIfAborted();
			writer.startPage();
			if (writer.full) break;
			let content;
			try {
				const page = await document.getPage(number);
				content = await page.getTextContent();
				page.cleanup();
			} catch {
				/* One damaged page leaves the others readable; it stays empty. */
				continue;
			}
			for (const item of content.items) {
				if ('str' in item) writer.write(item.str + (item.hasEOL ? '\n' : ''));
				if (writer.full) break;
			}
		}
		return count;
	} finally {
		await task.destroy();
	}
}
