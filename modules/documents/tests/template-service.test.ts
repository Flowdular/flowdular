import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StoragePort } from '@flowdular/storage';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { validateTemplateInput } from '../src/domain/template-schema.ts';
import type { DocumentRenderRequest } from '../src/domain/templates.ts';
import { createDocumentRenderRunner } from '../src/services/template-runner.ts';
import type {
	DocumentRenderer,
	DocumentRenderers,
} from '../src/services/render/renderer.ts';
import {
	DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
	DocumentTemplateRegistry,
	DocumentTemplatesService,
	renderFilename,
	TemplatesServiceError,
} from '../src/services/templates-service.ts';
import { readDocumentText } from '../src/services/text/extract.ts';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import {
	OFFER_BODY,
	OFFER_KEY,
	OFFER_SCHEMA,
	offerDefinition,
	offerInput,
	offerRegistry,
} from './support/templates.ts';

const TENANT = 'tenant-templates';
const OTHER = 'tenant-other';
const MANAGER = {
	accountId: 'account-ada',
	scopes: [DOCUMENTS_PERMISSIONS.manage, DOCUMENTS_PERMISSIONS.templatesRead],
};

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext({ maxObjectBytes: 4 * 1024 * 1024 });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function request(
	overrides: Partial<DocumentRenderRequest> = {},
): DocumentRenderRequest {
	return {
		tenantId: TENANT,
		principal: MANAGER,
		ownerModule: 'orders.core',
		recordRef: 'order-1',
		templateKey: OFFER_KEY,
		input: offerInput(3),
		...overrides,
	};
}

async function refusal(work: Promise<unknown>): Promise<TemplatesServiceError> {
	try {
		await work;
	} catch (error) {
		return error as TemplatesServiceError;
	}
	throw new Error('The call was not refused.');
}

async function storedBytes(documentId: string): Promise<Uint8Array> {
	const read = await context.storage.port.get({
		tenantId: TENANT,
		moduleId: 'documents.core',
		objectId: documentId,
	});
	return new Uint8Array(await new Response(read!.body).arrayBuffer());
}

async function documentRows(tenantId = TENANT) {
	return context.runtime.transaction(
		async (transaction) =>
			(
				await transaction.query<{
					id: string;
					filename: string;
					record_ref: string;
					description: string;
				}>({
					text: `SELECT id, filename, record_ref, description FROM documents_files ORDER BY created_at, id`,
				})
			).rows,
		{ tenantId, access: 'read' },
	);
}

describe('template registration', () => {
	it.each([
		[
			'a key outside the module namespace',
			{ key: 'billing.core.offer' },
			/the key must be orders.core/,
		],
		['an invalid body', { body: 'x\n<div>' }, /TEMPLATE_HTML on line 2/],
		[
			'a placeholder the schema lacks',
			{ body: '{{ secret }}' },
			/TEMPLATE_FIELD_UNKNOWN on line 1/,
		],
		[
			'a schema outside the subset',
			{
				inputSchema: {
					type: 'object',
					properties: { a: { type: 'string', format: 'email' } },
				},
			},
			/TEMPLATE_SCHEMA_INVALID/,
		],
		['an unknown locale', { locale: 'de' }, /the locale is en or pl/],
		['an invalid layout', { layout: { pageSize: 'A3' } }, /TEMPLATE_LAYOUT/],
		['an unknown format', { format: 'odt' }, /the format is pdf or docx/],
	])('DOCUMENTS-TEMPLATE-REGISTRATION refuses %s', (_, overrides, message) => {
		const registry = new DocumentTemplateRegistry();
		expect(() =>
			registry.register('orders.core', [offerDefinition(overrides as never)]),
		).toThrow(message);
		expect(registry.list()).toEqual([]);
	});

	it('DOCUMENTS-TEMPLATE-REGISTRATION lists a valid template and refuses a duplicate and a late registration', () => {
		const registry = offerRegistry();
		expect(
			registry.list().map((template) => [template.key, template.moduleId]),
		).toEqual([[OFFER_KEY, 'orders.core']]);
		expect(() => registry.register('orders.core', [offerDefinition()])).toThrow(
			/registered twice/,
		);
		registry.seal();
		expect(() =>
			registry.register('orders.core', [
				offerDefinition({ key: 'orders.core.other' }),
			]),
		).toThrow(/after documents.core started/);
	});
});

describe('template input', () => {
	it('DOCUMENTS-TEMPLATE-INPUT names the path of every issue', () => {
		expect(
			validateTemplateInput(OFFER_SCHEMA, {
				customer: 'x'.repeat(201),
				currency: 'USD',
				items: [{ price: 1.5 }, 'text'],
			}).map((issue) => [issue.path, issue.code]),
		).toEqual([
			['customer', 'MAX_LENGTH'],
			['currency', 'ENUM'],
			['items[0].name', 'REQUIRED'],
			['items[0].price', 'TYPE'],
			['items[1]', 'TYPE'],
		]);
		expect(
			validateTemplateInput(OFFER_SCHEMA, { customer: 'x' }).map(
				(issue) => issue.code,
			),
		).toEqual(['REQUIRED']);
		expect(validateTemplateInput(OFFER_SCHEMA, offerInput(2))).toEqual([]);
	});

	it('DOCUMENTS-TEMPLATE-INPUT refuses a render before anything is written', async () => {
		const service = context.templatesService(offerRegistry());
		const error = await refusal(
			service.render(request({ input: { customer: 7, items: [] } })),
		);
		expect([error.code, error.status]).toEqual(['TEMPLATE_INPUT_INVALID', 422]);
		expect(error.issues).toEqual([
			{ path: 'customer', code: 'TYPE', message: 'customer must be text.' },
		]);
		expect(await context.templates.listTemplates(TENANT, 10)).toEqual([]);
		expect(await documentRows()).toEqual([]);
	});
});

describe('template renders', () => {
	it('DOCUMENTS-RENDER-JOB renders a small input within the call and stores the document on the record', async () => {
		const service = context.templatesService(offerRegistry());
		const answer = await service.render(request());
		expect(answer).toMatchObject({
			status: 'succeeded',
			templateKey: OFFER_KEY,
			version: 1,
			format: 'pdf',
			errorCode: null,
		});
		expect(answer.documentId).toBe(answer.jobId);
		expect(await documentRows()).toEqual([
			{
				id: answer.jobId,
				filename: 'Oferta Spółka Żółw.pdf',
				record_ref: 'order-1',
				description: `${OFFER_KEY} v1`,
			},
		]);
		const text = await readDocumentText({
			contentType: 'application/pdf',
			bytes: await storedBytes(answer.documentId!),
			limits: DOCUMENT_TEXT_LIMITS,
		});
		expect(text.kind === 'text' && text.pages[0]).toContain(
			'Oferta dla Spółka Żółw',
		);
		const render = await context.templates.findRender(TENANT, answer.jobId);
		expect(render).toMatchObject({
			status: 'succeeded',
			input: '',
			attempts: 1,
		});
		expect(render!.inputDigest).toMatch(/^[0-9a-f]{64}$/);

		const again = await service.render(request());
		expect(again).toEqual(answer);
		expect(await documentRows()).toHaveLength(1);
		const other = await service.render(request({ input: offerInput(4) }));
		expect(other.documentId).not.toBe(answer.documentId);
		expect(await documentRows()).toHaveLength(2);
	});

	it('DOCUMENTS-RENDER-JOB stores a DOCX the storage port accepts', async () => {
		const service = context.templatesService(offerRegistry());
		const answer = await service.render(request({ format: 'docx' }));
		expect(answer).toMatchObject({ status: 'succeeded', format: 'docx' });
		const text = await readDocumentText({
			contentType:
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			bytes: await storedBytes(answer.documentId!),
			limits: DOCUMENT_TEXT_LIMITS,
		});
		expect(text.kind === 'text' && text.pages.join('\n')).toContain(
			'Pozycja 3',
		);
	});

	it('DOCUMENTS-RENDER-JOB queues a large render for the runner', async () => {
		let woken = 0;
		const service = context.templatesService(offerRegistry(), {
			wake: () => (woken += 1),
		});
		const answer = await service.render(request({ input: offerInput(51) }));
		expect(answer).toMatchObject({ status: 'queued', documentId: null });
		expect(woken).toBe(1);
		const runner = createDocumentRenderRunner({
			repository: async () => context.templates,
			service: async () => service,
		});
		await runner.tick();
		await runner.dispose();
		expect(await service.status(TENANT, answer.jobId)).toMatchObject({
			status: 'succeeded',
			documentId: answer.jobId,
		});
		expect(await service.status(OTHER, answer.jobId)).toBeNull();
	});

	it('DOCUMENTS-RENDER-JOB repeats a render that died mid render without a second document', async () => {
		const start = Date.UTC(2026, 8, 16, 10);
		let gate!: () => void;
		const held = new Promise<void>((resolve) => (gate = resolve));
		let stored = 0;
		const dying: StoragePort = {
			...context.storage.port,
			put: async (input) => {
				const object = await context.storage.port.put(input);
				stored += 1;
				await held;
				return object;
			},
		};
		const first = context.templatesService(offerRegistry(), {
			now: () => start,
		});
		const answer = await first.render(request({ input: offerInput(60) }));
		expect(answer.status).toBe('queued');
		const claimedFirst = await context.templates.claimRender({
			tenantId: TENANT,
			id: answer.jobId,
			claimedBy: 'process-a',
			claimedAt: start,
			staleBefore: start - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
		});
		const crashed = new DocumentTemplatesService({
			registry: offerRegistry(),
			repository: context.templates,
			documents: context.repository,
			storage: dying,
			quotaBytes: () => 10 * 1024 * 1024,
			timeZone: () => 'UTC',
			wake: () => undefined,
			now: () => start,
		});
		const late = crashed.perform(claimedFirst!, new AbortController().signal);
		await expect.poll(() => stored).toBe(1);
		expect(await context.storage.keys()).toEqual([
			`${TENANT}/documents.core/${answer.jobId}`,
		]);

		const later = start + DOCUMENT_RENDER_CLAIM_TIMEOUT_MS + 1;
		expect(
			await context.templates.claimRender({
				tenantId: TENANT,
				id: answer.jobId,
				claimedBy: 'process-b',
				claimedAt: start + 1,
				staleBefore: start + 1 - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
			}),
		).toBeNull();
		const second = context.templatesService(offerRegistry(), {
			now: () => later,
		});
		const claimedSecond = await context.templates.claimRender({
			tenantId: TENANT,
			id: answer.jobId,
			claimedBy: 'process-b',
			claimedAt: later,
			staleBefore: later - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
		});
		expect(claimedSecond).toMatchObject({ attempts: 2, status: 'running' });
		await second.perform(claimedSecond!, new AbortController().signal);
		expect(await second.status(TENANT, answer.jobId)).toMatchObject({
			status: 'succeeded',
			documentId: answer.jobId,
		});

		gate();
		await late;
		expect(await documentRows()).toHaveLength(1);
		expect(await context.storage.keys()).toEqual([
			`${TENANT}/documents.core/${answer.jobId}`,
		]);
		expect(
			await context.templates.findRender(TENANT, answer.jobId),
		).toMatchObject({ status: 'succeeded', attempts: 2 });
	});

	it('DOCUMENTS-RENDER-JOB renders again under a new id once the document was deleted, and retries a failed render', async () => {
		const service = context.templatesService(offerRegistry());
		const answer = await service.render(request());
		await context.service().remove(TENANT, answer.documentId!);
		const again = await service.render(request());
		expect(again).toMatchObject({
			jobId: answer.jobId,
			status: 'succeeded',
			documentId: `${answer.jobId}-g1`,
		});

		const tight = context.templatesService(offerRegistry(), {
			quotaBytes: () => 10,
		});
		const refused = await tight.render(request({ recordRef: 'order-2' }));
		expect(refused).toMatchObject({
			status: 'failed',
			errorCode: 'QUOTA_EXCEEDED',
			documentId: null,
		});
		expect(
			await context.templates.findRender(TENANT, refused.jobId),
		).toMatchObject({ input: '' });
		const retried = await service.render(request({ recordRef: 'order-2' }));
		expect(retried).toMatchObject({
			jobId: refused.jobId,
			status: 'succeeded',
			documentId: refused.jobId,
		});
	});

	it('DOCUMENTS-RENDER-JOB fails a render after three attempts and refuses a principal without documents.files.manage', async () => {
		const service = context.templatesService(offerRegistry(), {
			wake: () => undefined,
		});
		const answer = await service.render(request({ input: offerInput(55) }));
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const claimed = await context.templates.claimRender({
				tenantId: TENANT,
				id: answer.jobId,
				claimedBy: `attempt-${attempt}`,
				claimedAt: Date.now(),
				staleBefore: Date.now() - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
			});
			await context.templates.releaseRender(
				TENANT,
				answer.jobId,
				claimed!.claimedBy,
			);
		}
		const last = await context.templates.claimRender({
			tenantId: TENANT,
			id: answer.jobId,
			claimedBy: 'attempt-4',
			claimedAt: Date.now(),
			staleBefore: Date.now() - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
		});
		await service.perform(last!, new AbortController().signal);
		expect(await service.status(TENANT, answer.jobId)).toMatchObject({
			status: 'failed',
			errorCode: 'TEMPLATE_RENDER_FAILED',
		});

		const denied = await refusal(
			service.render(
				request({
					principal: {
						accountId: 'account-bo',
						scopes: [DOCUMENTS_PERMISSIONS.templatesRead],
					},
				}),
			),
		);
		expect([denied.code, denied.status]).toEqual(['FORBIDDEN', 403]);
	});
});

describe('template versions', () => {
	it('DOCUMENTS-TEMPLATE-VERSIONS keeps the default, appends edits, restores, reverts and follows a changed default', async () => {
		const original = context.templatesService(offerRegistry());
		const changedDefault = offerRegistry({
			body: OFFER_BODY + '\n\nNowa stopka.',
		});
		const upgraded = context.templatesService(changedDefault);

		const edited = await original.save(TENANT, 'account-ada', {
			key: OFFER_KEY,
			body: OFFER_BODY + '\n\nEdycja.',
			layout: { footer: 'Strona {{ page }}' },
			expectedVersion: 0,
		});
		expect([edited.version, edited.origin, edited.layout.footer]).toEqual([
			2,
			'edit',
			'Strona {{ page }}',
		]);
		expect(
			(await original.versions(TENANT, OFFER_KEY, null)).map((entry) => [
				entry.version,
				entry.origin,
			]),
		).toEqual([
			[2, 'edit'],
			[1, 'module'],
		]);

		const stale = await refusal(
			original.save(TENANT, 'account-ada', {
				key: OFFER_KEY,
				body: 'x',
				layout: {},
				expectedVersion: 1,
			}),
		);
		expect([stale.code, stale.status]).toEqual([
			'TEMPLATE_VERSION_CONFLICT',
			409,
		]);
		const invalid = await refusal(
			original.save(TENANT, 'account-ada', {
				key: OFFER_KEY,
				body: 'a\n\n```',
				layout: {},
				expectedVersion: 2,
			}),
		);
		expect([
			invalid.code,
			invalid.issues?.map((issue) => ('line' in issue ? issue.line : null)),
		]).toEqual(['TEMPLATE_INVALID', [3]]);

		const pinned = await upgraded.render(request());
		expect(pinned.version).toBe(2);

		const restored = await original.revert(TENANT, 'account-ada', {
			key: OFFER_KEY,
			expectedVersion: 2,
			toVersion: 1,
		});
		expect([restored.version, restored.origin, restored.body]).toEqual([
			3,
			'edit',
			OFFER_BODY,
		]);
		const reverted = await original.revert(TENANT, 'account-ada', {
			key: OFFER_KEY,
			expectedVersion: 3,
		});
		expect([reverted.version, reverted.origin]).toEqual([4, 'revert']);
		const unchanged = await refusal(
			original.revert(TENANT, 'account-ada', {
				key: OFFER_KEY,
				expectedVersion: 4,
			}),
		);
		expect(unchanged.code).toBe('TEMPLATE_UNCHANGED');

		const followed = await upgraded.render(request({ recordRef: 'order-2' }));
		expect(followed.version).toBe(5);
		expect((await upgraded.version(TENANT, OFFER_KEY, 5)).origin).toBe(
			'module',
		);
		expect(await upgraded.detail(TENANT, OFFER_KEY)).toMatchObject({
			followsDefault: true,
			defaultChanged: false,
			current: { version: 5 },
		});
		expect(await original.detail(TENANT, OFFER_KEY)).toMatchObject({
			followsDefault: true,
			defaultChanged: true,
		});

		expect(await original.list(OTHER)).toEqual([
			expect.objectContaining({
				key: OFFER_KEY,
				version: null,
				origin: null,
				ownerModule: 'orders.core',
			}),
		]);
		expect((await original.list(TENANT))[0]).toMatchObject({
			version: 5,
			origin: 'module',
			updatedBy: 'account-ada',
		});
	});
});

describe('template tables', () => {
	it('DOCUMENTS-TEMPLATE-TENANT keeps every workspace to its rows and gives the background role the routing columns alone', async () => {
		const service = context.templatesService(offerRegistry());
		await service.render(request(), undefined, 'key-tenant-0001');
		const queued = await service.render(
			request({ tenantId: OTHER, input: offerInput(60) }),
			undefined,
			'key-tenant-0002',
		);
		for (const table of [
			'document_templates',
			'document_template_versions',
			'document_renders',
			'document_render_keys',
		]) {
			const visible = await context.runtime.transaction(
				async (transaction) =>
					(
						await transaction.query<{ tenant_id: string }>({
							text: `SELECT tenant_id FROM ${table}`,
						})
					).rows,
				{ tenantId: TENANT, access: 'read' },
			);
			expect([
				table,
				[...new Set(visible.map((row) => row.tenant_id))],
			]).toEqual([table, [TENANT]]);
		}
		for (const statement of [
			`INSERT INTO document_templates (tenant_id, template_key, owner_module, current_version, updated_by, updated_at)
			 VALUES ($1, 'orders.core.forged', 'orders.core', 1, 'x', 1)`,
			`INSERT INTO document_template_versions (tenant_id, template_key, version, origin, body, layout, input_schema, locale, format, content_sha256, created_by, created_at)
			 VALUES ($1, 'orders.core.forged', 1, 'edit', 'x', '{}', '{}', 'en', 'pdf', repeat('a', 64), 'x', 1)`,
			`INSERT INTO document_renders (id, tenant_id, template_key, version, owner_module, record_ref, input_digest, format, status, requested_by, created_at)
			 VALUES ('forged-render', $1, 'orders.core.offer', 1, 'orders.core', 'order-1', repeat('a', 64), 'pdf', 'queued', 'x', 1)`,
			`INSERT INTO document_render_keys (tenant_id, idempotency_key, request_sha256, render_id, created_at)
			 VALUES ($1, 'forged-key', repeat('a', 64), 'forged-render', 1)`,
		]) {
			await expect(
				context.runtime.transaction(
					(transaction) =>
						transaction.execute({ text: statement, parameters: [OTHER] }),
					{ tenantId: TENANT, access: 'write' },
				),
			).rejects.toThrow();
		}
		expect(await context.templates.listPendingRenders(10, Date.now())).toEqual([
			{ id: queued.jobId, tenantId: OTHER, createdAt: expect.any(Number) },
		]);
		await expect(
			context.background.query({ text: 'SELECT input FROM document_renders' }),
		).rejects.toThrow();
		await expect(
			context.background.query({
				text: 'SELECT body FROM document_template_versions',
			}),
		).rejects.toThrow();
	});

	it('sweeps settled renders past the cutoff and keeps queued ones', async () => {
		const service = context.templatesService(offerRegistry(), {
			now: () => 1_000,
		});
		const settled = await service.render(request());
		const queued = await service.render(request({ input: offerInput(60) }));
		expect(await context.templates.sweepRenders(TENANT, 2_000, 100)).toBe(1);
		expect(
			await context.templates.findRender(TENANT, settled.jobId),
		).toBeNull();
		expect(
			await context.templates.findRender(TENANT, queued.jobId),
		).not.toBeNull();
		expect(await documentRows()).toHaveLength(1);
	});
});

/* A renderer that holds the render until the caller's signal aborts it. */
function holdingRenderers(started: () => void): DocumentRenderers {
	const hold: DocumentRenderer = {
		format: 'pdf',
		contentType: 'application/pdf',
		extension: 'pdf',
		render: (_document, _layout, options) =>
			new Promise((_, reject) => {
				started();
				if (options.signal?.aborted) reject(options.signal.reason);
				options.signal?.addEventListener('abort', () =>
					reject(options.signal!.reason),
				);
			}),
	};
	return { pdf: hold, docx: { ...hold, format: 'docx' } };
}

describe('template render lifecycle', () => {
	it('DOCUMENTS-RENDER-JOB aborts a render whose claim was lost without settling it', async () => {
		let started = 0;
		const service = context.templatesService(offerRegistry(), {
			renderers: holdingRenderers(() => (started += 1)),
		});
		const answer = await service.render(request({ input: offerInput(60) }));
		const runner = createDocumentRenderRunner({
			/* Every renewal answers that another process holds the claim. */
			repository: async () =>
				new Proxy(context.templates, {
					get: (target, name) => {
						if (name === 'heartbeatRender') return async () => false;
						const value = Reflect.get(target, name) as unknown;
						return typeof value === 'function' ? value.bind(target) : value;
					},
				}),
			service: async () => service,
			heartbeatEveryMs: 20,
		});
		await runner.tick();
		await runner.dispose();
		expect(started).toBe(1);
		expect(
			await context.templates.findRender(TENANT, answer.jobId),
		).toMatchObject({
			status: 'running',
			documentId: null,
		});
		expect(await documentRows()).toEqual([]);
	});

	it('DOCUMENTS-RENDER-JOB hands an inline render back at once when its caller stops waiting', async () => {
		const controller = new AbortController();
		const service = context.templatesService(offerRegistry(), {
			renderers: holdingRenderers(() => controller.abort(new Error('gone'))),
		});
		const answer = await service.render(request(), controller.signal);
		expect(answer).toMatchObject({ status: 'queued', documentId: null });
		expect(
			await context.templates.claimRender({
				tenantId: TENANT,
				id: answer.jobId,
				claimedBy: 'next-runner',
				claimedAt: Date.now(),
				staleBefore: Date.now() - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
			}),
		).toMatchObject({ attempts: 2 });
	});

	it('DOCUMENTS-RENDER-JOB removes the object an earlier attempt stored when the render fails', async () => {
		const service = context.templatesService(offerRegistry());
		const answer = await service.render(request({ input: offerInput(55) }));
		await context.storage.port.put({
			tenantId: TENANT,
			moduleId: 'documents.core',
			objectId: answer.jobId,
			contentType: 'application/pdf',
			body: Buffer.from('%PDF-1.7\nstale attempt\n%%EOF\n', 'latin1'),
		});
		const claimed = await context.templates.claimRender({
			tenantId: TENANT,
			id: answer.jobId,
			claimedBy: 'attempt',
			claimedAt: Date.now(),
			staleBefore: Date.now() - DOCUMENT_RENDER_CLAIM_TIMEOUT_MS,
		});
		await service.perform(
			{ ...claimed!, attempts: 4 },
			new AbortController().signal,
		);
		expect(await service.status(TENANT, answer.jobId)).toMatchObject({
			status: 'failed',
			errorCode: 'TEMPLATE_RENDER_FAILED',
		});
		expect(await context.storage.keys()).toEqual([]);
	});

	it('DOCUMENTS-TEMPLATE-ENDPOINTS refuses a preview past the concurrent bound', async () => {
		const service = context.templatesService(offerRegistry(), {
			renderers: holdingRenderers(() => undefined),
		});
		const controller = new AbortController();
		const preview = () =>
			service.preview(
				TENANT,
				{ key: OFFER_KEY, body: OFFER_BODY, layout: {}, input: offerInput(1) },
				controller.signal,
			);
		const running = [preview(), preview()];
		const busy = await refusal(preview());
		expect([busy.code, busy.status]).toEqual(['TEMPLATE_PREVIEW_BUSY', 429]);
		controller.abort(new Error('done'));
		await Promise.allSettled(running);
		await expect(preview()).rejects.toThrow('done');
	});

	it('names a rendered file after its title without splitting a character', () => {
		const title = 'Offer ' + 'x'.repeat(244) + '\u{1F600}tail';
		const name = renderFilename(title, OFFER_KEY, 'pdf');
		expect(name.endsWith('.pdf')).toBe(true);
		expect(() => encodeURIComponent(name)).not.toThrow();
		expect(renderFilename('a/b\\c\td', OFFER_KEY, 'docx')).toBe('a b c d.docx');
		expect(renderFilename('   ', OFFER_KEY, 'pdf')).toBe(`${OFFER_KEY}.pdf`);
	});
});

describe('template render keys', () => {
	it('DOCUMENTS-RENDER-TOOL keeps a key on the render written after a bound render was never written', async () => {
		let failures = 1;
		const failing = new DocumentTemplatesService({
			registry: offerRegistry(),
			repository: new Proxy(context.templates, {
				get: (target, name) => {
					if (name === 'createRender' && failures > 0) {
						return async () => {
							failures -= 1;
							throw new Error('connection dropped');
						};
					}
					const value = Reflect.get(target, name) as unknown;
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}),
			documents: context.repository,
			storage: context.storage.port,
			quotaBytes: () => 10 * 1024 * 1024,
			timeZone: () => 'UTC',
			wake: () => undefined,
		});
		await expect(
			failing.render(request(), undefined, 'key-lost-0001'),
		).rejects.toThrow('connection dropped');
		const service = context.templatesService(offerRegistry());
		const answered = await service.render(
			request(),
			undefined,
			'key-lost-0001',
		);
		expect(answered.status).toBe('succeeded');
		await service.save(TENANT, 'account-ada', {
			key: OFFER_KEY,
			body: OFFER_BODY + '\n\nNowa wersja.',
			layout: {},
			expectedVersion: 1,
		});
		expect(await service.render(request(), undefined, 'key-lost-0001')).toEqual(
			answered,
		);
		expect(await documentRows()).toHaveLength(1);
	});
});

describe('template render key sweep', () => {
	it('sweeps a key bound to a render that was never written once it is past the cutoff', async () => {
		const service = context.templatesService(offerRegistry(), {
			now: () => 1_000,
		});
		await service.render(request(), undefined, 'key-kept-0001');
		await context.templates.bindRenderKey({
			tenantId: TENANT,
			key: 'key-never-written',
			requestSha256: 'a'.repeat(64),
			renderId: 'never-written',
			at: 1_000,
		});
		expect(await context.templates.sweepRenders(TENANT, 500, 10)).toBe(0);
		expect(
			await context.templates.findRenderKey(TENANT, 'key-never-written'),
		).not.toBeNull();
		await context.templates.sweepRenders(TENANT, 2_000, 10);
		expect(
			await context.templates.findRenderKey(TENANT, 'key-never-written'),
		).toBeNull();
		expect(
			await context.templates.findRenderKey(TENANT, 'key-kept-0001'),
		).toBeNull();
	});
});
