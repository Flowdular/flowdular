import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentAttachments } from '../src/domain/attachments.ts';
import { createDocumentAttachments } from '../src/services/attachments.ts';
import type { DocumentsService } from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { infectedPdfBytes, pdfBytes } from './support/files.ts';
import { markerScanner } from './support/storage.ts';

const ACCOUNT = 'account-ada';

let context: DocumentsTestContext;
let documents: DocumentsService;
let attachments: DocumentAttachments;

beforeAll(async () => {
	context = await openDocumentsTestContext({ scanner: markerScanner });
	documents = context.service();
	/* The same factory the platform composition registers, so the contract under
	   test is the one another module resolves. */
	attachments = createDocumentAttachments(() => Promise.resolve(documents));
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function upload(
	tenantId: string,
	ownerModule: string,
	recordRef: string,
	filename: string,
) {
	return documents.upload(tenantId, ACCOUNT, {
		ownerModule,
		recordRef,
		filename,
		contentType: 'application/pdf',
		body: pdfBytes(filename),
	});
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks);
}

describe('documents attachments capability', () => {
	it('DOCUMENTS-ATTACH-BY-REFERENCE returns only the documents of that module and reference', async () => {
		await upload('tenant-a', 'directory.core', 'party-4711', 'contract.pdf');
		await upload('tenant-a', 'directory.core', 'party-4711', 'annex.pdf');
		await upload('tenant-a', 'directory.core', 'party-0002', 'other.pdf');
		await upload('tenant-a', 'users.core', 'party-4711', 'foreign.pdf');
		await upload('tenant-b', 'directory.core', 'party-4711', 'tenant-b.pdf');

		const listed = await attachments.list(
			'tenant-a',
			'directory.core',
			'party-4711',
		);
		expect(listed.map((entry) => entry.filename).sort()).toEqual([
			'annex.pdf',
			'contract.pdf',
		]);
		expect(
			listed.every((entry) => entry.ownerModule === 'directory.core'),
		).toBe(true);
	});

	it('DOCUMENTS-ATTACH-BY-REFERENCE never exposes the storage key', async () => {
		await upload('tenant-a', 'directory.core', 'party-4711', 'contract.pdf');
		const [entry] = await attachments.list(
			'tenant-a',
			'directory.core',
			'party-4711',
		);
		expect(Object.keys(entry!).sort()).toEqual([
			'bytes',
			'checksum',
			'contentType',
			'createdAt',
			'description',
			'filename',
			'id',
			'ownerModule',
			'recordRef',
			'scan',
			'status',
			'uploaderAccountId',
		]);
	});

	it('DOCUMENTS-ATTACH-BY-REFERENCE deletes the object first and then marks the row', async () => {
		const record = await upload(
			'tenant-a',
			'directory.core',
			'party-4711',
			'contract.pdf',
		);
		const reference = {
			tenantId: 'tenant-a',
			moduleId: 'documents.core',
			objectId: record.id,
		};

		expect(
			await attachments.delete(
				'tenant-a',
				'directory.core',
				'party-4711',
				record.id,
			),
		).toBe(true);
		expect(await context.storage.port.stat(reference)).toBeNull();
		expect((await context.repository.find('tenant-a', record.id))?.status).toBe(
			'deleted',
		);
		expect(
			await attachments.list('tenant-a', 'directory.core', 'party-4711'),
		).toEqual([]);
	});

	it('DOCUMENTS-ATTACH-BY-REFERENCE refuses a delete through another reference and stays idempotent', async () => {
		const record = await upload(
			'tenant-a',
			'directory.core',
			'party-4711',
			'contract.pdf',
		);

		expect(
			await attachments.delete(
				'tenant-a',
				'users.core',
				'party-4711',
				record.id,
			),
		).toBe(false);
		expect(
			await attachments.delete(
				'tenant-a',
				'directory.core',
				'party-0002',
				record.id,
			),
		).toBe(false);
		expect(
			await attachments.delete(
				'tenant-b',
				'directory.core',
				'party-4711',
				record.id,
			),
		).toBe(false);
		expect((await context.repository.find('tenant-a', record.id))?.status).toBe(
			'stored',
		);

		expect(
			await attachments.delete(
				'tenant-a',
				'directory.core',
				'party-4711',
				record.id,
			),
		).toBe(true);
		expect(
			await attachments.delete(
				'tenant-a',
				'directory.core',
				'party-4711',
				record.id,
			),
		).toBe(false);
	});

	it('DOCUMENTS-OPEN streams the bytes of its own record and names no storage key', async () => {
		const record = await upload(
			'tenant-a',
			'directory.core',
			'party-4711',
			'contract.pdf',
		);

		const opened = await attachments.open(
			'tenant-a',
			'directory.core',
			'party-4711',
			record.id,
		);

		expect(Object.keys(opened!).sort()).toEqual([
			'body',
			'bytes',
			'contentType',
			'filename',
		]);
		expect({
			contentType: opened!.contentType,
			bytes: opened!.bytes,
			filename: opened!.filename,
		}).toEqual({
			contentType: 'application/pdf',
			bytes: record.bytes,
			filename: 'contract.pdf',
		});
		expect(await readAll(opened!.body)).toEqual(
			Buffer.from(pdfBytes('contract.pdf')),
		);
	});

	it('DOCUMENTS-OPEN answers null for another module, record, workspace or id', async () => {
		const record = await upload(
			'tenant-a',
			'directory.core',
			'party-4711',
			'contract.pdf',
		);

		expect(
			await attachments.open('tenant-a', 'users.core', 'party-4711', record.id),
		).toBeNull();
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-0002',
				record.id,
			),
		).toBeNull();
		expect(
			await attachments.open(
				'tenant-b',
				'directory.core',
				'party-4711',
				record.id,
			),
		).toBeNull();
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-4711',
				'no-such-document',
			),
		).toBeNull();
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-4711',
				record.id,
			),
		).not.toBeNull();
	});

	it('DOCUMENTS-OPEN refuses an infected document and a deleted one', async () => {
		await expect(
			documents.upload('tenant-a', ACCOUNT, {
				ownerModule: 'directory.core',
				recordRef: 'party-4711',
				filename: 'malware.pdf',
				contentType: 'application/pdf',
				body: infectedPdfBytes(),
			}),
		).rejects.toMatchObject({ code: 'DOCUMENT_INFECTED' });
		const [trail] = await attachments.list(
			'tenant-a',
			'directory.core',
			'party-4711',
		);
		expect(trail?.scan).toBe('infected');
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-4711',
				trail!.id,
			),
		).toBeNull();

		/* The upload path never leaves an infected row with its object in place,
		   so the verdict is asserted on a row that has one: the refusal must be
		   the scan state itself, not the deleted status that happens to follow
		   it. */
		await context.storage.port.put({
			tenantId: 'tenant-a',
			moduleId: 'documents.core',
			objectId: 'infected-but-stored',
			contentType: 'application/pdf',
			body: pdfBytes('readable'),
		});
		await context.repository.create({
			id: 'infected-but-stored',
			tenantId: 'tenant-a',
			ownerModule: 'directory.core',
			recordRef: 'party-4711',
			filename: 'readable.pdf',
			contentType: 'application/pdf',
			bytes: pdfBytes('readable').byteLength,
			checksum: null,
			storageKey: 'tenant-a/documents.core/infected-but-stored',
			uploaderAccountId: ACCOUNT,
			scan: 'infected',
			status: 'stored',
			description: null,
			createdAt: Date.now(),
		});
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-4711',
				'infected-but-stored',
			),
		).toBeNull();

		const deleted = await upload(
			'tenant-a',
			'directory.core',
			'party-0002',
			'contract.pdf',
		);
		await attachments.delete(
			'tenant-a',
			'directory.core',
			'party-0002',
			deleted.id,
		);
		expect(
			await attachments.open(
				'tenant-a',
				'directory.core',
				'party-0002',
				deleted.id,
			),
		).toBeNull();
	});
});
