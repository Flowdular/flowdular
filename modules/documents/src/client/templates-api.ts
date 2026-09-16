import { t } from '@flowdular/client/i18n';
import type { TemplateObjectSchema } from '../domain/template-schema.ts';
import type {
	DocumentTemplateFormat,
	DocumentTemplateLayout,
	DocumentTemplateLocale,
	DocumentTemplateOrigin,
	TemplateIssue,
} from '../domain/templates.ts';
import { DocumentsApiError } from './api.ts';

/** A template as the list answers it; `version` is null while the workspace uses the module default. */
export interface TemplateListItem {
	readonly key: string;
	readonly ownerModule: string;
	readonly title: string;
	readonly format: DocumentTemplateFormat;
	readonly locale: DocumentTemplateLocale;
	readonly version: number | null;
	readonly origin: DocumentTemplateOrigin | null;
	readonly updatedBy: string | null;
	readonly updatedAt: number | null;
}

export interface TemplateVersionView {
	readonly version: number | null;
	readonly origin: DocumentTemplateOrigin;
	readonly body: string;
	readonly layout: DocumentTemplateLayout;
	readonly inputSchema: TemplateObjectSchema;
	readonly locale: DocumentTemplateLocale;
	readonly format: DocumentTemplateFormat;
	readonly createdBy: string | null;
	readonly createdAt: number | null;
}

export interface TemplateDetail {
	readonly key: string;
	readonly ownerModule: string;
	readonly title: string;
	readonly current: TemplateVersionView;
	readonly moduleDefault: TemplateVersionView;
	readonly followsDefault: boolean;
	readonly defaultChanged: boolean;
}

export interface TemplateVersionSummary {
	readonly version: number;
	readonly origin: DocumentTemplateOrigin;
	readonly contentSha256: string;
	readonly createdBy: string;
	readonly createdAt: number;
}

export interface TemplateVersionPage {
	readonly items: readonly TemplateVersionSummary[];
	readonly page: { readonly nextCursor: string | null };
}

/** An issue of the input rather than of the template: it names a path, not a line. */
export interface TemplateInputIssue {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

/** A refusal that carries the template's line-numbered issues or the input's path issues. */
export class TemplatesApiError extends DocumentsApiError {
	readonly issues: readonly (TemplateIssue | TemplateInputIssue)[];

	constructor(
		status: number,
		code: string,
		message: string,
		issues: readonly (TemplateIssue | TemplateInputIssue)[],
	) {
		super(status, code, message);
		this.name = 'TemplatesApiError';
		this.issues = issues;
	}
}

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
		readonly issues?: readonly (TemplateIssue | TemplateInputIssue)[];
	};
}

async function refusal(response: Response): Promise<TemplatesApiError> {
	let envelope: ErrorEnvelope = {};
	try {
		envelope = (await response.json()) as ErrorEnvelope;
	} catch {
		envelope = {};
	}
	return new TemplatesApiError(
		response.status,
		envelope.error?.code ?? 'REQUEST_FAILED',
		envelope.error?.message ?? t('documents.error.request'),
		Array.isArray(envelope.error?.issues) ? envelope.error.issues : [],
	);
}

async function payload<T>(response: Response): Promise<T> {
	if (!response.ok) throw await refusal(response);
	return (await response.json()) as T;
}

function get<T>(path: string): Promise<T> {
	return fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	}).then((response) => payload<T>(response));
}

function post(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<Response> {
	return fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
}

export async function loadTemplates(): Promise<readonly TemplateListItem[]> {
	return (
		await get<{ readonly items: readonly TemplateListItem[] }>(
			'/api/documents/templates',
		)
	).items;
}

export async function loadTemplateDetail(key: string): Promise<TemplateDetail> {
	return (
		await get<{ readonly template: TemplateDetail }>(
			'/api/documents/templates/detail?' +
				new URLSearchParams({ key }).toString(),
		)
	).template;
}

export function loadTemplateVersions(
	key: string,
	cursor: string | null,
): Promise<TemplateVersionPage> {
	const query = new URLSearchParams({ key });
	if (cursor) query.set('cursor', cursor);
	return get<TemplateVersionPage>(
		'/api/documents/templates/versions?' + query.toString(),
	);
}

export async function loadTemplateVersion(
	key: string,
	version: number,
): Promise<TemplateVersionView> {
	return (
		await get<{ readonly version: TemplateVersionView }>(
			'/api/documents/templates/version?' +
				new URLSearchParams({ key, version: String(version) }).toString(),
		)
	).version;
}

export interface TemplateDraft {
	readonly key: string;
	readonly body: string;
	readonly layout: unknown;
}

export interface TemplatePreviewFile {
	readonly blob: Blob;
	readonly contentType: string;
	readonly filename: string;
}

/** The rendered bytes of a draft; nothing is stored on the server. */
export async function previewTemplate(
	draft: TemplateDraft & {
		readonly input: unknown;
		readonly format: DocumentTemplateFormat;
	},
	csrfToken: string,
): Promise<TemplatePreviewFile> {
	const response = await post(
		'/api/documents/templates/preview',
		draft,
		csrfToken,
	);
	if (!response.ok) throw await refusal(response);
	const contentType = response.headers.get('content-type') ?? '';
	return {
		blob: await response.blob(),
		contentType,
		filename: dispositionFilename(
			response.headers.get('content-disposition'),
			draft.key,
			draft.format,
		),
	};
}

/** The UTF-8 name a content disposition carries, or the key with the format's extension. */
export function dispositionFilename(
	header: string | null,
	key: string,
	format: DocumentTemplateFormat,
): string {
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1];
	if (encoded) {
		try {
			const decoded = decodeURIComponent(encoded).replace(/[/\\]/g, '_').trim();
			if (decoded !== '') return decoded;
		} catch {
			/* A malformed escape falls back to the key. */
		}
	}
	return `${key}.${format}`;
}

export async function saveTemplate(
	draft: TemplateDraft & { readonly expectedVersion: number },
	csrfToken: string,
): Promise<TemplateVersionView> {
	return (
		await payload<{ readonly version: TemplateVersionView }>(
			await post('/api/documents/templates/save', draft, csrfToken),
		)
	).version;
}

/** Without `toVersion` the module default becomes the next version; with it, that version's body and layout. */
export async function revertTemplate(
	input: {
		readonly key: string;
		readonly expectedVersion: number;
		readonly toVersion?: number | null;
	},
	csrfToken: string,
): Promise<TemplateVersionView> {
	return (
		await payload<{ readonly version: TemplateVersionView }>(
			await post('/api/documents/templates/revert', input, csrfToken),
		)
	).version;
}
