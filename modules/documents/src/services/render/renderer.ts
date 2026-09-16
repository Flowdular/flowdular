import type { RenderedTemplate } from '../../domain/template-evaluate.ts';
import type {
	DocumentTemplateFormat,
	DocumentTemplateLayout,
} from '../../domain/templates.ts';
import { docxRenderer } from './docx.ts';
import { pdfRenderer } from './pdf.ts';

export interface RenderOptions {
	/** The moment the document is dated with, so a repeated render carries the same date. */
	readonly createdAt: number;
	readonly signal?: AbortSignal | undefined;
}

/**
 * One output format. A renderer takes a template already evaluated against its
 * input, so it never sees a placeholder and never reads the input itself; a
 * Chromium renderer would be one more entry here.
 */
export interface DocumentRenderer {
	readonly format: DocumentTemplateFormat;
	readonly contentType: string;
	readonly extension: string;
	render(
		document: RenderedTemplate,
		layout: DocumentTemplateLayout,
		options: RenderOptions,
	): Promise<Uint8Array>;
}

export type DocumentRenderers = Readonly<
	Record<DocumentTemplateFormat, DocumentRenderer>
>;

export function createDocumentRenderers(): DocumentRenderers {
	return { pdf: pdfRenderer, docx: docxRenderer };
}

export const MILLIMETRE_IN_POINTS = 72 / 25.4;

/* A CommonJS build reached through import answers its exports object under
   default in Node and the export itself under a bundler's interop. */
export function commonJsDefault<T>(module: unknown): T {
	const outer = (module as { default?: unknown }).default ?? module;
	return ((outer as { default?: unknown }).default ?? outer) as T;
}
