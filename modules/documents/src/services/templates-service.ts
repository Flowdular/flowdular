import { createHash, randomUUID } from 'node:crypto';
import {
	StorageError,
	storageObjectKey,
	type StorageObjectRef,
	type StoragePort,
} from '@flowdular/storage';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import {
	compileTemplate,
	normalizeTemplateLayout,
	type CompiledTemplate,
	type TemplateContent,
} from '../domain/template-compile.ts';
import {
	evaluateTemplate,
	TemplateRenderError,
	type RenderedTemplate,
} from '../domain/template-evaluate.ts';
import {
	canonicalJson,
	templateSchemaProblem,
	validateTemplateInput,
	type TemplateInputIssue,
	type TemplateObjectSchema,
} from '../domain/template-schema.ts';
import {
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	DOCUMENT_TEMPLATE_LOCALES,
	templateKeyValid,
	type DocumentRenderAnswer,
	type DocumentRenderRequest,
	type DocumentTemplateDefinition,
	type DocumentTemplateFormat,
	type DocumentTemplateLayout,
	type DocumentTemplateLocale,
	type DocumentTemplateOrigin,
	type TemplateIssue,
} from '../domain/templates.ts';
import { DOCUMENT_LIMITS, type DocumentsFile } from '../domain/types.ts';
import {
	bounded,
	DocumentsServiceError,
	DOCUMENTS_STORAGE_MODULE,
} from './documents-service.ts';
import {
	createDocumentRenderers,
	type DocumentRenderers,
} from './render/renderer.ts';
import type { DocumentsRepository } from './repository.ts';
import type {
	ClaimedRender,
	DocumentRenderRecord,
	DocumentTemplatesRepository,
	RenderKey,
	TemplateVersionContent,
	TemplateVersionRecord,
	TemplateVersionSummary,
} from './templates-repository.ts';

/** Claims a render may take before it settles as failed. */
export const DOCUMENT_RENDER_MAX_ATTEMPTS = 3;

/** Longer than the largest render a runner performs, which the bounds keep in seconds. */
export const DOCUMENT_RENDER_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

const VERSION_PAGE = 50;

/** A refusal that carries the line-numbered template issues or the input issues. */
export class TemplatesServiceError extends DocumentsServiceError {
	constructor(
		code: string,
		message: string,
		status: number,
		readonly issues:
			| readonly TemplateIssue[]
			| readonly TemplateInputIssue[]
			| undefined = undefined,
	) {
		super(code, message, status);
		this.name = 'TemplatesServiceError';
	}
}

export class DocumentTemplateRegistrationError extends Error {
	readonly code = 'TEMPLATE_REGISTRATION_INVALID';
	constructor(message: string) {
		super(`TEMPLATE_REGISTRATION_INVALID: ${message}`);
		this.name = 'DocumentTemplateRegistrationError';
	}
}

/** A module's default, validated once at registration. */
export interface RegisteredTemplate {
	readonly key: string;
	readonly moduleId: string;
	readonly title: string;
	readonly content: TemplateContent;
	readonly contentSha256: string;
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function templateContentSha256(content: TemplateContent): string {
	return sha256Hex(
		canonicalJson({
			body: content.body,
			layout: content.layout,
			inputSchema: content.inputSchema,
			locale: content.locale,
			format: content.format,
		}),
	);
}

function issueSummary(issues: readonly TemplateIssue[]): string {
	const first = issues[0]!;
	return `${first.code}${first.line === null ? '' : ` on line ${first.line}`}: ${first.message}`;
}

/**
 * The templates modules ship. Registration happens while the platform composes
 * and closes when documents.core starts, so a request never sees the catalogue
 * change under it.
 */
export class DocumentTemplateRegistry {
	readonly #templates = new Map<string, RegisteredTemplate>();
	#sealed = false;

	register(
		moduleId: string,
		templates: readonly DocumentTemplateDefinition[],
	): void {
		if (this.#sealed) {
			throw new DocumentTemplateRegistrationError(
				`${moduleId} registered templates after documents.core started.`,
			);
		}
		if (
			typeof moduleId !== 'string' ||
			!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(moduleId)
		) {
			throw new DocumentTemplateRegistrationError(
				'the module id is not a module id.',
			);
		}
		if (!Array.isArray(templates)) {
			throw new DocumentTemplateRegistrationError(
				`${moduleId} registered something other than a list.`,
			);
		}
		const accepted = new Map<string, RegisteredTemplate>();
		for (const definition of templates) {
			const entry = this.#accept(moduleId, definition);
			if (this.#templates.has(entry.key) || accepted.has(entry.key)) {
				throw new DocumentTemplateRegistrationError(
					`${entry.key} is registered twice.`,
				);
			}
			accepted.set(entry.key, entry);
		}
		if (
			this.#templates.size + accepted.size >
			DOCUMENT_TEMPLATE_LIMITS.registeredTemplates
		) {
			throw new DocumentTemplateRegistrationError(
				`a deployment registers at most ${DOCUMENT_TEMPLATE_LIMITS.registeredTemplates} templates.`,
			);
		}
		for (const [key, entry] of accepted) this.#templates.set(key, entry);
	}

	seal(): void {
		this.#sealed = true;
	}

	get(key: string): RegisteredTemplate | null {
		return this.#templates.get(key) ?? null;
	}

	list(): readonly RegisteredTemplate[] {
		return [...this.#templates.values()].sort((left, right) =>
			left.key.localeCompare(right.key),
		);
	}

	#accept(
		moduleId: string,
		definition: DocumentTemplateDefinition,
	): RegisteredTemplate {
		const value = (definition ?? {}) as Partial<DocumentTemplateDefinition>;
		const key = typeof value.key === 'string' ? value.key : '';
		const at = `${moduleId} template ${key.slice(0, 128) || '(no key)'}`;
		if (!templateKeyValid(key, moduleId)) {
			throw new DocumentTemplateRegistrationError(
				`${at}: the key must be ${moduleId}.<name>.`,
			);
		}
		if (
			typeof value.title !== 'string' ||
			value.title.trim() === '' ||
			value.title.length > DOCUMENT_TEMPLATE_LIMITS.title
		) {
			throw new DocumentTemplateRegistrationError(
				`${at}: the title is 1 to ${DOCUMENT_TEMPLATE_LIMITS.title} characters.`,
			);
		}
		if (
			!(DOCUMENT_TEMPLATE_FORMATS as readonly unknown[]).includes(value.format)
		) {
			throw new DocumentTemplateRegistrationError(
				`${at}: the format is pdf or docx.`,
			);
		}
		if (
			!(DOCUMENT_TEMPLATE_LOCALES as readonly unknown[]).includes(value.locale)
		) {
			throw new DocumentTemplateRegistrationError(
				`${at}: the locale is en or pl.`,
			);
		}
		const schemaProblem = templateSchemaProblem(value.inputSchema);
		if (schemaProblem) {
			throw new DocumentTemplateRegistrationError(
				`${at}: TEMPLATE_SCHEMA_INVALID: ${schemaProblem}`,
			);
		}
		const layout = normalizeTemplateLayout(value.layout, value.title);
		if (layout.issues.length > 0) {
			throw new DocumentTemplateRegistrationError(
				`${at}: ${issueSummary(layout.issues)}`,
			);
		}
		const content: TemplateContent = {
			body: typeof value.body === 'string' ? value.body : '',
			layout: layout.layout,
			inputSchema: value.inputSchema as TemplateObjectSchema,
			locale: value.locale as DocumentTemplateLocale,
			format: value.format as DocumentTemplateFormat,
		};
		if (typeof value.body !== 'string') {
			throw new DocumentTemplateRegistrationError(
				`${at}: the body must be text.`,
			);
		}
		const { issues } = compileTemplate(content);
		if (issues.length > 0) {
			throw new DocumentTemplateRegistrationError(
				`${at}: ${issueSummary(issues)}`,
			);
		}
		return {
			key,
			moduleId,
			title: value.title,
			content,
			contentSha256: templateContentSha256(content),
		};
	}
}

export interface DocumentTemplatesServiceOptions {
	readonly registry: DocumentTemplateRegistry;
	readonly repository: DocumentTemplatesRepository;
	readonly documents: DocumentsRepository;
	readonly storage: StoragePort;
	readonly quotaBytes: (tenantId: string) => number | Promise<number>;
	/** The workspace IANA zone, read live. */
	readonly timeZone: (tenantId: string) => string | Promise<string>;
	/** Asks the render runner for a pass that sees a render queued now. */
	readonly wake: () => void;
	readonly renderers?: DocumentRenderers | undefined;
	readonly now?: (() => number) | undefined;
	readonly newId?: (() => string) | undefined;
}

export interface TemplateListItem {
	readonly key: string;
	readonly ownerModule: string;
	readonly title: string;
	readonly format: DocumentTemplateFormat;
	readonly locale: DocumentTemplateLocale;
	/** Null while the workspace still uses the module default without a kept version. */
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
	/** The current version came from the default or a revert to it. */
	readonly followsDefault: boolean;
	/** The default changed since the current version was kept; the next render keeps it. */
	readonly defaultChanged: boolean;
}

export interface TemplatePreviewInput {
	readonly key: string;
	readonly body: string;
	readonly layout: unknown;
	readonly input: unknown;
	readonly format?: DocumentTemplateFormat | undefined;
}

/** Drafts one process renders for preview at the same time. */
export const DOCUMENT_TEMPLATE_PREVIEWS = 2;

export interface TemplatePreview {
	readonly bytes: Uint8Array;
	readonly contentType: string;
	readonly filename: string;
}

function notFound(): TemplatesServiceError {
	return new TemplatesServiceError(
		'TEMPLATE_NOT_FOUND',
		'No template is registered under that key.',
		404,
	);
}

function invalidInput(message: string): DocumentsServiceError {
	return new DocumentsServiceError('INVALID_INPUT', message);
}

function renderRefusal(error: TemplateRenderError): TemplatesServiceError {
	return new TemplatesServiceError(error.code, error.message, 422);
}

export function renderFilename(
	title: string,
	key: string,
	extension: string,
): string {
	/* Cut by code point, so a character outside the basic plane is never
	   split into half a surrogate pair. */
	const cleaned = Array.from(
		title
			.replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	)
		.slice(0, DOCUMENT_LIMITS.filename - extension.length - 1)
		.join('')
		.trim();
	return `${cleaned === '' ? key : cleaned}.${extension}`;
}

function answer(render: DocumentRenderRecord): DocumentRenderAnswer {
	return {
		jobId: render.id,
		status: render.status,
		documentId: render.status === 'succeeded' ? render.documentId : null,
		errorCode: render.errorCode,
		templateKey: render.templateKey,
		version: render.version,
		format: render.format,
	};
}

/**
 * Template versions, previews and renders. A render is a row first and a
 * document after: the row is the job the runner claims, and its document is
 * inserted in the transaction that settles it.
 */
export class DocumentTemplatesService {
	readonly #options: DocumentTemplatesServiceOptions;
	readonly #renderers: DocumentRenderers;
	readonly #now: () => number;
	readonly #newId: () => string;
	readonly #compiled = new Map<string, CompiledTemplate>();
	#previews = 0;

	constructor(options: DocumentTemplatesServiceOptions) {
		this.#options = options;
		this.#renderers = options.renderers ?? createDocumentRenderers();
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? randomUUID;
	}

	async list(tenantId: string): Promise<readonly TemplateListItem[]> {
		const tenant = this.#tenant(tenantId);
		const rows = new Map(
			(
				await this.#options.repository.listTemplates(
					tenant,
					DOCUMENT_TEMPLATE_LIMITS.registeredTemplates * 4,
				)
			).map((row) => [row.key, row]),
		);
		return this.#options.registry.list().map((template) => {
			const row = rows.get(template.key);
			return {
				key: template.key,
				ownerModule: template.moduleId,
				title: template.title,
				format: template.content.format,
				locale: template.content.locale,
				version: row?.currentVersion ?? null,
				origin: row?.origin ?? null,
				updatedBy: row?.updatedBy ?? null,
				updatedAt: row?.updatedAt ?? null,
			};
		});
	}

	async detail(tenantId: string, key: string): Promise<TemplateDetail> {
		const tenant = this.#tenant(tenantId);
		const template = this.#template(key);
		const current = await this.#options.repository.currentVersion(
			tenant,
			template.key,
		);
		const moduleDefault = this.#defaultView(template);
		const followsDefault = !current || current.version.origin !== 'edit';
		return {
			key: template.key,
			ownerModule: template.moduleId,
			title: template.title,
			current: current ? this.#versionView(current.version) : moduleDefault,
			moduleDefault,
			followsDefault,
			defaultChanged:
				current !== null &&
				followsDefault &&
				current.version.contentSha256 !== template.contentSha256,
		};
	}

	async versions(
		tenantId: string,
		key: string,
		before: number | null,
		limit = VERSION_PAGE,
	): Promise<readonly TemplateVersionSummary[]> {
		const template = this.#template(key);
		return this.#options.repository.listVersions(
			this.#tenant(tenantId),
			template.key,
			Math.min(Math.max(Math.trunc(limit), 1), VERSION_PAGE),
			before,
		);
	}

	async version(
		tenantId: string,
		key: string,
		version: number,
	): Promise<TemplateVersionView> {
		const template = this.#template(key);
		const found =
			Number.isSafeInteger(version) && version >= 1
				? await this.#options.repository.findVersion(
						this.#tenant(tenantId),
						template.key,
						version,
					)
				: null;
		if (!found) {
			throw new TemplatesServiceError(
				'TEMPLATE_VERSION_NOT_FOUND',
				'The template has no such version.',
				404,
			);
		}
		return this.#versionView(found);
	}

	/** Appends an edit of the body and layout, validated against the module's schema. */
	async save(
		tenantId: string,
		actor: string,
		input: {
			readonly key: string;
			readonly body: string;
			readonly layout: unknown;
			readonly expectedVersion: number;
		},
	): Promise<TemplateVersionView> {
		const template = this.#template(input.key);
		const content = this.#draftContent(
			template,
			input.body,
			input.layout,
			null,
		);
		return this.#append(tenantId, actor, template, input.expectedVersion, {
			...content,
			origin: 'edit',
		});
	}

	/**
	 * Appends a copy of the module default, or of the body and layout of an
	 * earlier version when `toVersion` names one.
	 */
	async revert(
		tenantId: string,
		actor: string,
		input: {
			readonly key: string;
			readonly expectedVersion: number;
			readonly toVersion?: number | null;
		},
	): Promise<TemplateVersionView> {
		const template = this.#template(input.key);
		if (input.toVersion === undefined || input.toVersion === null) {
			return this.#append(tenantId, actor, template, input.expectedVersion, {
				...this.#storedContent(template.content),
				origin: 'revert',
			});
		}
		const earlier = await this.version(tenantId, template.key, input.toVersion);
		const content = this.#draftContent(
			template,
			earlier.body,
			earlier.layout,
			null,
		);
		return this.#append(tenantId, actor, template, input.expectedVersion, {
			...content,
			origin: 'edit',
		});
	}

	/** Renders a draft with a sample input to bytes, storing nothing. */
	async preview(
		tenantId: string,
		input: TemplatePreviewInput,
		signal?: AbortSignal,
	): Promise<TemplatePreview> {
		/* Laying out a document holds the event loop for as long as it takes, so
		   one process renders a bounded number of drafts at a time. */
		if (this.#previews >= DOCUMENT_TEMPLATE_PREVIEWS) {
			throw new TemplatesServiceError(
				'TEMPLATE_PREVIEW_BUSY',
				'Other previews are rendering. Try again in a moment.',
				429,
			);
		}
		this.#previews += 1;
		try {
			return await this.#preview(tenantId, input, signal);
		} finally {
			this.#previews -= 1;
		}
	}

	async #preview(
		tenantId: string,
		input: TemplatePreviewInput,
		signal: AbortSignal | undefined,
	): Promise<TemplatePreview> {
		const tenant = this.#tenant(tenantId);
		const template = this.#template(input.key);
		const content = this.#draftContent(
			template,
			input.body,
			input.layout,
			input.format ?? null,
		);
		const compiled = this.#compile(content.contentSha256, content.parsed);
		const value = this.#input(content.parsed.inputSchema, input.input).value;
		const rendered = await this.#evaluate(tenant, compiled, value);
		const renderer = this.#renderers[content.parsed.format];
		try {
			const bytes = await renderer.render(rendered, content.parsed.layout, {
				createdAt: this.#now(),
				signal,
			});
			return {
				bytes,
				contentType: renderer.contentType,
				filename: renderFilename(
					rendered.title,
					template.key,
					renderer.extension,
				),
			};
		} catch (error) {
			if (error instanceof TemplateRenderError) throw renderRefusal(error);
			throw error;
		}
	}

	/**
	 * `idempotencyKey` is the key a caller derived for one call, such as the
	 * harness for a tool call: a repeat of that call answers the render it first
	 * reached, even when the template gained a version since.
	 */
	async render(
		request: DocumentRenderRequest,
		signal?: AbortSignal,
		idempotencyKey?: string,
	): Promise<DocumentRenderAnswer> {
		const tenant = this.#tenant(request.tenantId);
		const principal = request.principal;
		if (
			!principal ||
			!Array.isArray(principal.scopes) ||
			!principal.scopes.includes(DOCUMENTS_PERMISSIONS.manage)
		) {
			throw new TemplatesServiceError(
				'FORBIDDEN',
				'Rendering a document requires documents.files.manage.',
				403,
			);
		}
		const account = bounded(
			String(principal.accountId ?? ''),
			'accountId',
			1,
			DOCUMENT_LIMITS.accountId,
		);
		const ownerModule = bounded(
			String(request.ownerModule ?? ''),
			'ownerModule',
			1,
			DOCUMENT_LIMITS.ownerModule,
		);
		const recordRef = bounded(
			String(request.recordRef ?? ''),
			'recordRef',
			1,
			DOCUMENT_LIMITS.recordRef,
		);
		const template = this.#template(String(request.templateKey ?? ''));
		if (
			request.format !== undefined &&
			!(DOCUMENT_TEMPLATE_FORMATS as readonly unknown[]).includes(
				request.format,
			)
		) {
			throw invalidInput('format is pdf or docx.');
		}
		const key =
			idempotencyKey === undefined
				? null
				: {
						value: bounded(idempotencyKey, 'idempotencyKey', 8, 128),
						requestSha256: sha256Hex(
							canonicalJson({
								templateKey: template.key,
								ownerModule,
								recordRef,
								format: request.format ?? null,
								input: request.input ?? null,
							}),
						),
					};
		if (key) {
			const bound = await this.#options.repository.findRenderKey(
				tenant,
				key.value,
			);
			const reached = bound && (await this.#boundRender(tenant, bound, key));
			if (reached) return answer(reached);
		}
		/* The input is checked against the version the render will use before
		   anything is written, and again should that version change meanwhile. */
		const kept = await this.#options.repository.currentVersion(
			tenant,
			template.key,
		);
		const used =
			kept &&
			(kept.version.origin === 'edit' ||
				kept.version.contentSha256 === template.contentSha256)
				? {
						sha: kept.version.contentSha256,
						content: this.#contentOf(kept.version),
					}
				: { sha: template.contentSha256, content: template.content };
		let { value, text } = this.#input(used.content.inputSchema, request.input);
		let rendered = await this.#evaluate(
			tenant,
			this.#compile(used.sha, used.content),
			value,
		);
		const current = await this.#ensureVersion(tenant, account, template);
		const content = this.#contentOf(current);
		if (current.contentSha256 !== used.sha) {
			({ value, text } = this.#input(content.inputSchema, request.input));
			rendered = await this.#evaluate(
				tenant,
				this.#compile(current.contentSha256, content),
				value,
			);
		}
		const inputDigest = sha256Hex(canonicalJson(value));
		const planned = this.#newId();
		/* The key is bound to the render id before the row exists, so two calls
		   racing on one key never leave a render nobody answered for. */
		if (key) {
			const bound = await this.#options.repository.bindRenderKey({
				tenantId: tenant,
				key: key.value,
				requestSha256: key.requestSha256,
				renderId: planned,
				at: this.#now(),
			});
			if (bound.renderId !== planned) {
				const reached = await this.#boundRender(tenant, bound, key);
				if (reached) return answer(reached);
				/* The render the key names was never written, so the key follows
				   the one this call writes now. */
				await this.#options.repository.rebindRenderKey({
					tenantId: tenant,
					key: key.value,
					from: bound.renderId,
					to: planned,
				});
			}
		}
		const created = await this.#options.repository.createRender({
			id: planned,
			tenantId: tenant,
			templateKey: template.key,
			version: current.version,
			ownerModule,
			recordRef,
			inputDigest,
			input: text,
			format: request.format ?? content.format,
			requestedBy: account,
			createdAt: this.#now(),
		});
		let render = created.render;
		if (!created.created) {
			render = await this.#reuse(render, text, account);
			if (key) {
				await this.#options.repository.rebindRenderKey({
					tenantId: tenant,
					key: key.value,
					from: planned,
					to: render.id,
				});
			}
		}
		if (render.status !== 'queued') return answer(render);
		const inline =
			rendered.repeatedRows <= DOCUMENT_TEMPLATE_LIMITS.inlineRows &&
			Buffer.byteLength(text, 'utf8') <=
				DOCUMENT_TEMPLATE_LIMITS.inlineInputBytes;
		if (!inline) {
			this.#options.wake();
			return answer(render);
		}
		const at = this.#now();
		const claimed = await this.#options.repository.claimRender({
			tenantId: tenant,
			id: render.id,
			claimedBy: randomUUID(),
			claimedAt: at,
			staleBefore: at - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
		});
		if (!claimed)
			return answer(
				(await this.#options.repository.findRender(tenant, render.id)) ??
					render,
			);
		try {
			await this.perform(claimed, signal ?? new AbortController().signal);
		} catch {
			/* A caller that stopped waiting leaves the claim to the runner at once
			   rather than after the stale window. */
			if (signal?.aborted) {
				await this.#options.repository
					.releaseRender(tenant, render.id, claimed.claimedBy)
					.catch(() => false);
			}
			this.#options.wake();
		}
		return answer(
			(await this.#options.repository.findRender(tenant, render.id)) ?? render,
		);
	}

	async status(
		tenantId: string,
		jobId: string,
	): Promise<DocumentRenderAnswer | null> {
		const found = await this.#options.repository.findRender(
			this.#tenant(tenantId),
			bounded(String(jobId ?? ''), 'jobId', 1, DOCUMENT_LIMITS.id),
		);
		return found ? answer(found) : null;
	}

	/** One claimed render. Settles nothing once the claim is lost. */
	async perform(job: ClaimedRender, signal: AbortSignal): Promise<void> {
		const repository = this.#options.repository;
		const reference: StorageObjectRef = {
			tenantId: job.tenantId,
			moduleId: DOCUMENTS_STORAGE_MODULE,
			objectId: job.generation === 0 ? job.id : `${job.id}-g${job.generation}`,
		};
		/* An earlier attempt may have stored the object before it died. Only the
		   holder of the claim removes it: a claim lost to a render that succeeded
		   under the same object id must leave that document's bytes alone. */
		const fail = async (code: string) => {
			const failed = await repository.failRender(
				job.tenantId,
				job.id,
				job.claimedBy,
				code,
				this.#now(),
			);
			if (failed) {
				await this.#options.storage.delete(reference).catch(() => false);
			}
		};
		if (job.attempts > DOCUMENT_RENDER_MAX_ATTEMPTS) {
			await fail('TEMPLATE_RENDER_FAILED');
			return;
		}
		const version = await repository.findVersion(
			job.tenantId,
			job.templateKey,
			job.version,
		);
		if (!version) {
			await fail('TEMPLATE_VERSION_NOT_FOUND');
			return;
		}
		const renderer = this.#renderers[job.format];
		try {
			const content = this.#contentOf(version);
			const compiled = this.#compile(version.contentSha256, content);
			const rendered = await this.#evaluate(
				job.tenantId,
				compiled,
				JSON.parse(job.input) as unknown,
			);
			const bytes = await renderer.render(rendered, content.layout, {
				createdAt: job.createdAt,
				signal,
			});
			signal.throwIfAborted();
			const remaining =
				(await this.#options.quotaBytes(job.tenantId)) -
				(await this.#options.documents.storedBytes(job.tenantId));
			if (bytes.byteLength > remaining) {
				await fail('QUOTA_EXCEEDED');
				return;
			}
			const object = await this.#options.storage.put({
				...reference,
				contentType: renderer.contentType,
				body: bytes,
			});
			signal.throwIfAborted();
			const document: DocumentsFile = {
				id: reference.objectId,
				tenantId: job.tenantId,
				ownerModule: job.ownerModule,
				recordRef: job.recordRef,
				filename: renderFilename(
					rendered.title,
					job.templateKey,
					renderer.extension,
				),
				contentType: object.contentType,
				bytes: object.bytes,
				checksum: object.checksum,
				storageKey: storageObjectKey(reference),
				uploaderAccountId: job.requestedBy,
				scan: object.scan,
				status: 'stored',
				description: `${job.templateKey} v${job.version}`,
				createdAt: this.#now(),
			};
			await repository.completeRender({
				tenantId: job.tenantId,
				id: job.id,
				claimedBy: job.claimedBy,
				document,
				at: this.#now(),
			});
		} catch (error) {
			if (signal.aborted) throw error;
			if (
				error instanceof TemplateRenderError ||
				error instanceof TemplatesServiceError
			) {
				await fail(error.code);
				return;
			}
			if (
				error instanceof StorageError &&
				error.code !== 'STORAGE_UNAVAILABLE'
			) {
				await fail(
					error.code === 'OBJECT_INFECTED' ? 'DOCUMENT_INFECTED' : error.code,
				);
				return;
			}
			/* A failure that is not the render's own hands the claim back, so the
			   next pass tries again within the attempts. */
			await repository
				.releaseRender(job.tenantId, job.id, job.claimedBy)
				.catch(() => false);
			throw error;
		}
	}

	async #boundRender(
		tenant: string,
		bound: RenderKey,
		key: { readonly requestSha256: string },
	): Promise<DocumentRenderRecord | null> {
		if (bound.requestSha256 !== key.requestSha256) {
			throw new TemplatesServiceError(
				'TEMPLATE_RENDER_KEY_REUSED',
				'The idempotency key was used for another render request.',
				409,
			);
		}
		return this.#options.repository.findRender(tenant, bound.renderId);
	}

	async #reuse(
		render: DocumentRenderRecord,
		input: string,
		account: string,
	): Promise<DocumentRenderRecord> {
		const repository = this.#options.repository;
		let observed: 'failed' | 'succeeded' | null = null;
		if (render.status === 'failed') observed = 'failed';
		if (render.status === 'succeeded' && render.documentId) {
			const document = await this.#options.documents.find(
				render.tenantId,
				render.documentId,
			);
			if (!document || document.status !== 'stored') observed = 'succeeded';
		}
		if (!observed) return render;
		return (
			(await repository.requeueRender({
				tenantId: render.tenantId,
				id: render.id,
				observed,
				input,
				requestedBy: account,
				nextGeneration: observed === 'succeeded',
			})) ??
			(await repository.findRender(render.tenantId, render.id)) ??
			render
		);
	}

	/*
	 * The version a render uses. A workspace without one keeps the default as
	 * version 1; one that follows the default keeps a changed default as its
	 * next version; an edited one renders its edit.
	 */
	async #ensureVersion(
		tenant: string,
		account: string,
		template: RegisteredTemplate,
	): Promise<TemplateVersionRecord> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current = await this.#options.repository.currentVersion(
				tenant,
				template.key,
			);
			if (
				current &&
				(current.version.origin === 'edit' ||
					current.version.contentSha256 === template.contentSha256)
			) {
				return current.version;
			}
			const appended = await this.#options.repository.appendVersions({
				tenantId: tenant,
				key: template.key,
				ownerModule: template.moduleId,
				expectedVersion: current?.template.currentVersion ?? 0,
				contents: [
					{ ...this.#storedContent(template.content), origin: 'module' },
				],
				actor: account,
				at: this.#now(),
			});
			if (appended !== 'conflict') return appended.at(-1)!;
		}
		throw new TemplatesServiceError(
			'TEMPLATE_VERSION_CONFLICT',
			'The template changed while the render read it. Try again.',
			409,
		);
	}

	async #append(
		tenantId: string,
		actor: string,
		template: RegisteredTemplate,
		expectedVersion: number,
		content: TemplateVersionContent,
	): Promise<TemplateVersionView> {
		const tenant = this.#tenant(tenantId);
		const account = bounded(actor, 'accountId', 1, DOCUMENT_LIMITS.accountId);
		if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
			throw invalidInput(
				'expectedVersion is the version the change was made on, 0 for the module default.',
			);
		}
		const current = await this.#options.repository.currentVersion(
			tenant,
			template.key,
		);
		if ((current?.template.currentVersion ?? 0) !== expectedVersion)
			throw this.#conflict();
		const currentSha = current?.version.contentSha256 ?? template.contentSha256;
		const followsDefault = !current || current.version.origin !== 'edit';
		const unchanged =
			content.origin === 'revert'
				? followsDefault && currentSha === template.contentSha256
				: currentSha === content.contentSha256;
		if (unchanged) {
			throw new TemplatesServiceError(
				'TEMPLATE_UNCHANGED',
				'The template already reads like that.',
				409,
			);
		}
		const contents: TemplateVersionContent[] = current
			? [content]
			: [
					{ ...this.#storedContent(template.content), origin: 'module' },
					content,
				];
		const appended = await this.#options.repository.appendVersions({
			tenantId: tenant,
			key: template.key,
			ownerModule: template.moduleId,
			expectedVersion,
			contents,
			actor: account,
			at: this.#now(),
		});
		if (appended === 'conflict') throw this.#conflict();
		return this.#versionView(appended.at(-1)!);
	}

	#conflict(): TemplatesServiceError {
		return new TemplatesServiceError(
			'TEMPLATE_VERSION_CONFLICT',
			'Someone saved another version of this template first. Reload it and apply the change again.',
			409,
		);
	}

	#draftContent(
		template: RegisteredTemplate,
		body: unknown,
		layout: unknown,
		format: DocumentTemplateFormat | null,
	): Omit<TemplateVersionContent, 'origin'> & {
		readonly parsed: TemplateContent;
	} {
		if (typeof body !== 'string') throw invalidInput('body must be text.');
		if (
			format !== null &&
			!(DOCUMENT_TEMPLATE_FORMATS as readonly unknown[]).includes(format)
		) {
			throw invalidInput('format is pdf or docx.');
		}
		const normalized = normalizeTemplateLayout(layout, template.title);
		const parsed: TemplateContent = {
			body,
			layout: normalized.layout,
			inputSchema: template.content.inputSchema,
			locale: template.content.locale,
			format: format ?? template.content.format,
		};
		const issues = [...normalized.issues, ...compileTemplate(parsed).issues];
		if (issues.length > 0) {
			throw new TemplatesServiceError(
				'TEMPLATE_INVALID',
				issueSummary(issues),
				422,
				issues,
			);
		}
		const stored = { ...parsed, format: template.content.format };
		return { ...this.#storedContent(stored), parsed };
	}

	#storedContent(
		content: TemplateContent,
	): Omit<TemplateVersionContent, 'origin'> {
		return {
			body: content.body,
			layout: canonicalJson(content.layout),
			inputSchema: canonicalJson(content.inputSchema),
			locale: content.locale,
			format: content.format,
			contentSha256: templateContentSha256(content),
		};
	}

	#contentOf(version: TemplateVersionRecord): TemplateContent {
		return {
			body: version.body,
			layout: JSON.parse(version.layout) as DocumentTemplateLayout,
			inputSchema: JSON.parse(version.inputSchema) as TemplateObjectSchema,
			locale: version.locale,
			format: version.format,
		};
	}

	#versionView(version: TemplateVersionRecord): TemplateVersionView {
		const content = this.#contentOf(version);
		return {
			version: version.version,
			origin: version.origin,
			...content,
			createdBy: version.createdBy,
			createdAt: version.createdAt,
		};
	}

	#defaultView(template: RegisteredTemplate): TemplateVersionView {
		return {
			version: null,
			origin: 'module',
			...template.content,
			createdBy: null,
			createdAt: null,
		};
	}

	#compile(sha: string, content: TemplateContent): CompiledTemplate {
		const cached = this.#compiled.get(sha);
		if (cached) return cached;
		const { compiled, issues } = compileTemplate(content);
		if (!compiled) {
			throw new TemplateRenderError(
				'TEMPLATE_VALUE_INVALID',
				issueSummary(issues),
			);
		}
		if (this.#compiled.size >= 128)
			this.#compiled.delete(this.#compiled.keys().next().value!);
		this.#compiled.set(sha, compiled);
		return compiled;
	}

	#input(
		schema: TemplateObjectSchema,
		input: unknown,
	): { readonly value: unknown; readonly text: string } {
		let text: string | undefined;
		try {
			text = JSON.stringify(input ?? null);
		} catch {
			text = undefined;
		}
		if (
			text === undefined ||
			Buffer.byteLength(text, 'utf8') > DOCUMENT_TEMPLATE_LIMITS.inputBytes
		) {
			throw new TemplatesServiceError(
				'TEMPLATE_INPUT_INVALID',
				`The input must be JSON of at most ${DOCUMENT_TEMPLATE_LIMITS.inputBytes} bytes.`,
				422,
				[
					{
						path: '',
						code: 'TOO_LARGE',
						message: 'The input is not JSON or is too large.',
					},
				],
			);
		}
		const value = JSON.parse(text) as unknown;
		const issues = validateTemplateInput(schema, value);
		if (issues.length > 0) {
			throw new TemplatesServiceError(
				'TEMPLATE_INPUT_INVALID',
				issues.map((issue) => issue.message).join(' '),
				422,
				issues,
			);
		}
		return { value, text };
	}

	async #evaluate(
		tenant: string,
		compiled: CompiledTemplate,
		input: unknown,
	): Promise<RenderedTemplate> {
		const timeZone = await this.#options.timeZone(tenant);
		try {
			return evaluateTemplate(compiled, input, {
				locale: compiled.content.locale,
				timeZone,
			});
		} catch (error) {
			if (error instanceof TemplateRenderError) throw renderRefusal(error);
			throw error;
		}
	}

	#template(key: string): RegisteredTemplate {
		const template = this.#options.registry.get(String(key ?? ''));
		if (!template) throw notFound();
		return template;
	}

	#tenant(tenantId: string): string {
		return bounded(
			String(tenantId ?? ''),
			'tenantId',
			1,
			DOCUMENT_LIMITS.accountId,
		);
	}
}
