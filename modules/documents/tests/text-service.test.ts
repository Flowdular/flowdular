import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StoragePort } from '@flowdular/storage';
import type { DocumentTextExtraction } from '../src/domain/text.ts';
import { createDocumentTextRunner } from '../src/services/text-runner.ts';
import {
	createDocumentTextExtraction,
	DocumentTextService,
	type DocumentTextServiceOptions,
} from '../src/services/text-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import {
	docxBytes,
	DOCX_TYPE,
	paragraph,
	pdfDocument,
} from './support/text-fixtures.ts';

const ACCOUNT = 'account-ada';
const OWNER = 'directory.core';
const RECORD = 'party-4711';

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext();
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function upload(
	tenantId: string,
	contentType: string,
	body: Uint8Array,
	recordRef = RECORD,
) {
	return context.service().upload(tenantId, ACCOUNT, {
		ownerModule: OWNER,
		recordRef,
		filename: 'file',
		contentType,
		body,
	});
}

/* The port with every object read counted, so a case can prove a read cost no
   parse at all. */
function counting(port: StoragePort): StoragePort & { reads: number } {
	const counted = {
		...port,
		reads: 0,
		get: async (reference: Parameters<StoragePort['get']>[0]) => {
			counted.reads += 1;
			return port.get(reference);
		},
	};
	return counted;
}

function textService(
	options: Partial<DocumentTextServiceOptions> = {},
): DocumentTextService {
	return new DocumentTextService({
		repository: context.repository,
		storage: context.storage.port,
		ocr: null,
		wake: () => undefined,
		...options,
	});
}

function capability(service: DocumentTextService): DocumentTextExtraction {
	return createDocumentTextExtraction(() => Promise.resolve(service));
}

describe('documents text capability', () => {
	it('DOCUMENTS-TEXT-FORMATS answers the text of a stored document of the caller reference and nothing for another', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Page one', 'Page two']),
		);
		const docx = await upload(
			'tenant-a',
			DOCX_TYPE,
			docxBytes(paragraph('Policy 42')),
		);
		const legacy = await upload(
			'tenant-a',
			'application/msword',
			Buffer.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2),
		);
		const text = capability(textService());

		expect(await text.extract('tenant-a', OWNER, RECORD, pdf.id)).toEqual({
			status: 'ok',
			reason: null,
			text: 'Page one\fPage two',
			pages: 2,
			from: 1,
			to: 2,
			truncated: false,
			contentSha256: pdf.checksum!.slice('sha256:'.length),
		});
		expect(
			await text.extract('tenant-a', OWNER, RECORD, docx.id),
		).toMatchObject({ status: 'ok', text: 'Policy 42', pages: 1 });
		expect(
			await text.extract('tenant-a', OWNER, RECORD, legacy.id),
		).toMatchObject({
			status: 'unsupported',
			reason: 'DOCUMENT_TEXT_FORMAT',
			text: '',
		});
		expect(
			await text.extract('tenant-a', 'users.core', RECORD, pdf.id),
		).toBeNull();
		expect(
			await text.extract('tenant-a', OWNER, 'party-0002', pdf.id),
		).toBeNull();
		expect(await text.extract('tenant-b', OWNER, RECORD, pdf.id)).toBeNull();
	});

	it('DOCUMENTS-TEXT-PAGES answers a range, an empty range past the end and refuses a reversed one', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Page 1', 'Page 2', 'Page 3']),
		);
		const text = capability(textService());

		expect(
			await text.extract('tenant-a', OWNER, RECORD, pdf.id, {
				pages: { from: 2, to: 3 },
			}),
		).toMatchObject({ text: 'Page 2\fPage 3', from: 2, to: 3, pages: 3 });
		expect(
			await text.extract('tenant-a', OWNER, RECORD, pdf.id, {
				pages: { from: 4, to: 9 },
			}),
		).toMatchObject({ text: '', from: 4, to: 3, truncated: false });
		for (const pages of [
			{ from: 3, to: 2 },
			{ from: 0, to: 2 },
			{ from: 1.5, to: 2 },
		]) {
			await expect(
				text.extract('tenant-a', OWNER, RECORD, pdf.id, { pages }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
	});

	it('DOCUMENTS-TEXT-PAGES keeps a range past the kept pages truncated only where the document was cut', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Page 1', 'Page 2', 'Page 3']),
		);
		const text = capability(textService({ limits: { pages: 2 } }));

		expect(
			await text.extract('tenant-a', OWNER, RECORD, pdf.id, {
				pages: { from: 1, to: 500 },
			}),
		).toMatchObject({
			text: 'Page 1\fPage 2',
			to: 2,
			pages: 3,
			truncated: true,
		});
		expect(
			await text.extract('tenant-a', OWNER, RECORD, pdf.id, {
				pages: { from: 1, to: 1 },
			}),
		).toMatchObject({ text: 'Page 1', truncated: false });
	});

	it('DOCUMENTS-TEXT-BOUNDS answers bytes over the input bound as too large without reading them', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Page 1']),
		);
		const storage = counting(context.storage.port);
		const text = capability(
			textService({ storage, limits: { inputBytes: 10 } }),
		);
		expect(await text.extract('tenant-a', OWNER, RECORD, pdf.id)).toMatchObject(
			{ status: 'too-large', reason: 'DOCUMENT_TEXT_TOO_LARGE' },
		);
		expect(storage.reads).toBe(0);
		expect(
			await text.extractBytes({
				contentType: 'application/pdf',
				bytes: pdfDocument(['Page 1']),
			}),
		).toMatchObject({ status: 'too-large' });
	});

	it('DOCUMENTS-TEXT-CACHE reads a document once, copies the row of the same bytes and deletes it with its document', async () => {
		const bytes = pdfDocument(['Cached page']);
		const first = await upload('tenant-a', 'application/pdf', bytes);
		const second = await upload(
			'tenant-a',
			'application/pdf',
			bytes,
			'party-0002',
		);
		const storage = counting(context.storage.port);
		const text = capability(textService({ storage }));

		expect(
			await text.extract('tenant-a', OWNER, RECORD, first.id),
		).toMatchObject({ text: 'Cached page' });
		expect(storage.reads).toBe(1);
		expect(
			await text.extract('tenant-a', OWNER, RECORD, first.id),
		).toMatchObject({ text: 'Cached page' });
		expect(
			await text.extract('tenant-a', OWNER, 'party-0002', second.id),
		).toMatchObject({ text: 'Cached page' });
		expect(storage.reads).toBe(1);

		await context.service().remove('tenant-a', first.id);
		expect(await context.repository.findText('tenant-a', first.id)).toBeNull();
		expect(
			await context.repository.findText('tenant-a', second.id),
		).toMatchObject({ status: 'ok', text: 'Cached page' });
	});

	it('DOCUMENTS-TEXT-FORMATS reads bytes that are not stored within the call', async () => {
		const text = capability(textService());
		const bytes = pdfDocument(['Fetched page']);
		const answer = await text.extractBytes({
			contentType: 'application/pdf',
			bytes,
		});
		expect(answer).toMatchObject({
			status: 'ok',
			text: 'Fetched page',
			pages: 1,
		});
		expect(answer.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(
			await text.extractBytes({
				contentType: 'application/pdf',
				bytes: pdfDocument([null]),
			}),
		).toMatchObject({
			status: 'unscanned',
			reason: 'DOCUMENT_OCR_UNCONFIGURED',
			pages: 1,
		});
	});
});

describe('documents text runner', () => {
	function runner(service: DocumentTextService, claimTimeoutMs?: number) {
		return createDocumentTextRunner({
			repository: () => Promise.resolve(context.repository),
			service: () => Promise.resolve(service),
			pollIntervalMs: 60_000,
			claimTimeoutMs,
			onEvent: () => undefined,
		});
	}

	it('DOCUMENTS-TEXT-PENDING answers a large document pending and the runner settles it', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Large page']),
		);
		let woken = 0;
		const service = textService({
			limits: { inlineBytes: 10 },
			wake: () => {
				woken += 1;
			},
		});
		const text = capability(service);

		expect(await text.extract('tenant-a', OWNER, RECORD, pdf.id)).toMatchObject(
			{ status: 'pending', reason: null, text: '' },
		);
		expect(woken).toBe(1);

		const jobs = runner(service);
		expect(await jobs.tick()).toMatchObject({ claimed: 1, performed: 1 });
		expect(await text.extract('tenant-a', OWNER, RECORD, pdf.id)).toMatchObject(
			{ status: 'ok', text: 'Large page' },
		);
		await jobs.dispose();
	});

	it('DOCUMENTS-TEXT-PENDING takes over a stale claim and refuses the settle of the claim it replaced', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Recovered page']),
		);
		const service = textService({ limits: { inlineBytes: 10 } });
		await capability(service).extract('tenant-a', OWNER, RECORD, pdf.id);
		const at = Date.now();
		expect(
			await context.repository.claimText({
				tenantId: 'tenant-a',
				documentId: pdf.id,
				claimedBy: 'runner-that-died',
				claimedAt: at,
				staleBefore: at - 60_000,
			}),
		).toMatchObject({ attempts: 1 });

		const fresh = runner(service);
		expect(await fresh.tick()).toMatchObject({ claimed: 0 });
		const takeover = runner(service, 0);
		expect(await takeover.tick()).toMatchObject({ claimed: 1, performed: 1 });

		expect(
			await context.repository.settleText(
				'tenant-a',
				pdf.id,
				'runner-that-died',
				{
					status: 'unsupported',
					reason: 'DOCUMENT_TEXT_FAILED',
					text: '',
					pages: 0,
					truncated: false,
				},
				Date.now(),
			),
		).toBe(false);
		expect(await context.repository.findText('tenant-a', pdf.id)).toMatchObject(
			{ status: 'ok', text: 'Recovered page', attempts: 2 },
		);
		await fresh.dispose();
		await takeover.dispose();
	});

	it('DOCUMENTS-TEXT-PENDING settles a row that failed three attempts as failed and removes the row of a deleted document', async () => {
		const pdf = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Never read']),
		);
		const gone = await upload(
			'tenant-a',
			'application/pdf',
			pdfDocument(['Deleted meanwhile']),
			'party-0002',
		);
		const service = textService({ limits: { inlineBytes: 10 } });
		const text = capability(service);
		await text.extract('tenant-a', OWNER, RECORD, pdf.id);
		await text.extract('tenant-a', OWNER, 'party-0002', gone.id);
		for (const token of ['one', 'two', 'three']) {
			await context.repository.claimText({
				tenantId: 'tenant-a',
				documentId: pdf.id,
				claimedBy: token,
				claimedAt: Date.now(),
				staleBefore: Date.now() + 60_000,
			});
		}
		await context.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE documents_files SET status = 'deleted' WHERE tenant_id = $1 AND id = $2`,
					parameters: ['tenant-a', gone.id],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		const jobs = runner(service, 0);
		await jobs.tick();
		expect(await text.extract('tenant-a', OWNER, RECORD, pdf.id)).toMatchObject(
			{
				status: 'unsupported',
				reason: 'DOCUMENT_TEXT_FAILED',
			},
		);
		expect(await context.repository.findText('tenant-a', gone.id)).toBeNull();
		await jobs.dispose();
	});
});

describe('documents text tenant boundary', () => {
	const settled = {
		status: 'ok' as const,
		reason: null,
		text: 'secret',
		pages: 1,
		truncated: false,
	};

	it('DOCUMENTS-TEXT-TENANT shows and writes only the rows of the bound workspace', async () => {
		await context.repository.saveText(
			'tenant-a',
			'document-1',
			'a'.repeat(64),
			settled,
			1,
		);
		await context.repository.saveText(
			'tenant-b',
			'document-1',
			'b'.repeat(64),
			{ ...settled, text: 'other' },
			1,
		);
		expect(
			await context.repository.findText('tenant-a', 'document-1'),
		).toMatchObject({ text: 'secret' });
		const visible = await context.runtime.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string }>({
					text: 'SELECT tenant_id FROM documents_text',
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		);
		expect(visible.rows.map((row) => row.tenant_id)).toEqual(['tenant-a']);
		await expect(
			context.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO documents_text
						 (tenant_id, document_id, content_sha256, status, requested_at)
						 VALUES ('tenant-b', 'document-2', $1, 'ok', 1)`,
						parameters: ['c'.repeat(64)],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();
		expect(
			await context.repository.copyTextByChecksum(
				'tenant-a',
				'document-3',
				'b'.repeat(64),
				1,
			),
		).toBeNull();
	});

	it('DOCUMENTS-TEXT-TENANT lets the background role read the routing columns of pending rows and nothing else', async () => {
		await context.repository.saveText(
			'tenant-a',
			'document-1',
			'a'.repeat(64),
			settled,
			1,
		);
		await context.repository.enqueueText(
			'tenant-b',
			'document-2',
			'b'.repeat(64),
			2,
		);
		expect(await context.repository.listPendingText(10)).toEqual([
			{ tenantId: 'tenant-b', documentId: 'document-2', requestedAt: 2 },
		]);
		await expect(
			context.background.query({ text: 'SELECT text FROM documents_text' }),
		).rejects.toThrow();
	});
});
