import type { TemplateInputSchema } from './template-schema.ts';

/**
 * The public template surface. A module registers the templates it ships with
 * `register` while the platform composes, and renders one for its own record
 * with `render` after it checked its own permission on that record.
 */
export const DOCUMENTS_TEMPLATES_CAPABILITY = 'documents.templates.v1';

export const DOCUMENT_TEMPLATE_FORMATS = ['pdf', 'docx'] as const;
export type DocumentTemplateFormat = (typeof DOCUMENT_TEMPLATE_FORMATS)[number];

export const DOCUMENT_TEMPLATE_LOCALES = ['en', 'pl'] as const;
export type DocumentTemplateLocale = (typeof DOCUMENT_TEMPLATE_LOCALES)[number];

export const DOCUMENT_TEMPLATE_PAGE_SIZES = ['A4', 'Letter'] as const;
export type DocumentTemplatePageSize =
	(typeof DOCUMENT_TEMPLATE_PAGE_SIZES)[number];

export const DOCUMENT_RENDER_STATUSES = [
	'queued',
	'running',
	'succeeded',
	'failed',
] as const;
export type DocumentRenderStatus = (typeof DOCUMENT_RENDER_STATUSES)[number];

/** How a version came to be: the module default, an edit or restore, or a revert to the default. */
export const DOCUMENT_TEMPLATE_ORIGINS = ['module', 'edit', 'revert'] as const;
export type DocumentTemplateOrigin = (typeof DOCUMENT_TEMPLATE_ORIGINS)[number];

export const DOCUMENT_TEMPLATE_LIMITS = {
	key: 128,
	title: 200,
	bodyCharacters: 65_536,
	/** Title, header and footer lines. */
	lineCharacters: 200,
	blockDepth: 8,
	marginMinMm: 5,
	marginMaxMm: 60,
	/** Rows or blocks every each block of one render repeats together. */
	repeatedRows: 2_000,
	printedCharacters: 1_000_000,
	pages: 200,
	inputBytes: 256 * 1024,
	stringCharacters: 10_000,
	arrayItems: 2_000,
	schemaDepth: 4,
	schemaProperties: 64,
	inputIssues: 20,
	registeredTemplates: 256,
	/** A render at or under both is performed within the call. */
	inlineRows: 50,
	inlineInputBytes: 16 * 1024,
} as const;

export interface DocumentTemplateMargins {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export interface DocumentTemplateLayout {
	readonly pageSize: DocumentTemplatePageSize;
	/** Millimetres. */
	readonly margins: DocumentTemplateMargins;
	readonly header: string | null;
	readonly footer: string | null;
	/** The document title and the stored file name, with placeholders. */
	readonly title: string;
}

export const DEFAULT_TEMPLATE_MARGINS: DocumentTemplateMargins = {
	top: 20,
	right: 20,
	bottom: 20,
	left: 20,
};

export interface DocumentTemplateDefinition {
	/** `<module id>.<name>`, inside the registering module's namespace. */
	readonly key: string;
	readonly title: string;
	readonly format: DocumentTemplateFormat;
	readonly body: string;
	readonly inputSchema: TemplateInputSchema;
	readonly locale: DocumentTemplateLocale;
	/** Absent fields take A4, 20 mm margins, no header or footer and the template title. */
	readonly layout?: Partial<DocumentTemplateLayout>;
}

/** The principal a render is performed for; the scopes are checked live by the caller. */
export interface DocumentRenderPrincipal {
	readonly accountId: string;
	readonly scopes: readonly string[];
}

export interface DocumentRenderRequest {
	readonly tenantId: string;
	readonly principal: DocumentRenderPrincipal;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly templateKey: string;
	readonly input: unknown;
	readonly format?: DocumentTemplateFormat | undefined;
}

export interface DocumentRenderAnswer {
	readonly jobId: string;
	readonly status: DocumentRenderStatus;
	readonly documentId: string | null;
	readonly errorCode: string | null;
	readonly templateKey: string;
	readonly version: number;
	readonly format: DocumentTemplateFormat;
}

export interface DocumentTemplates {
	/**
	 * Declares the templates a module ships. Called while the platform composes;
	 * an invalid template throws TEMPLATE_REGISTRATION_INVALID at boot.
	 */
	register(
		moduleId: string,
		templates: readonly DocumentTemplateDefinition[],
	): void;
	/**
	 * Renders a template for a record and stores the document as its attachment.
	 * Idempotent by template version, record, format and input.
	 */
	render(request: DocumentRenderRequest): Promise<DocumentRenderAnswer>;
	status(tenantId: string, jobId: string): Promise<DocumentRenderAnswer | null>;
}

/** One validation refusal of a template, with the 1-based body line or the layout field. */
export interface TemplateIssue {
	readonly code: string;
	readonly message: string;
	readonly line: number | null;
	readonly field?: 'body' | 'title' | 'header' | 'footer' | 'layout';
}

export function templateKeyValid(key: string, moduleId: string): boolean {
	return (
		key.length <= DOCUMENT_TEMPLATE_LIMITS.key &&
		key.startsWith(moduleId + '.') &&
		/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(key)
	);
}
