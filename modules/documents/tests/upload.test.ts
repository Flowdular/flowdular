import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	DocumentsService,
	DocumentsServiceError,
} from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import {
	executableBytes,
	infectedPdfBytes,
	pdfBytes,
	pngBytes,
	textBytes,
} from './support/files.ts';
import { markerScanner } from './support/storage.ts';

const TENANT = 'tenant-a';
const ACCOUNT = 'account-ada';
const OBJECT_ID = 'document-0001';

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext({ scanner: markerScanner });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function upload(
	body: Uint8Array,
	overrides: {
		readonly contentType?: string;
		readonly filename?: string;
		readonly declaredBytes?: number;
	} = {},
) {
	return {
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename: overrides.filename ?? 'contract.pdf',
		contentType: overrides.contentType ?? 'application/pdf',
		description: 'Signed copy',
		...(overrides.declaredBytes === undefined
			? {}
			: { declaredBytes: overrides.declaredBytes }),
		body,
	};
}

/** The refusal a caller can branch on, without asserting the sentence. */
async function refusal(
	run: () => Promise<unknown>,
): Promise<{ readonly code: string; readonly status: number }> {
	try {
		await run();
	} catch (error) {
		if (error instanceof DocumentsServiceError) {
			return { code: error.code, status: error.status };
		}
		throw error;
	}
	throw new Error('The call was expected to be refused.');
}

function objectRef(objectId = OBJECT_ID) {
	return { tenantId: TENANT, moduleId: 'documents.core', objectId };
}

describe('documents upload', () => {
	it('DOCUMENTS-UPLOAD stores the object under a tenant-first key and records its metadata', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		const record = await service.upload(TENANT, ACCOUNT, upload(pdfBytes()));

		expect({
			id: record.id,
			storageKey: record.storageKey,
			filename: record.filename,
			contentType: record.contentType,
			ownerModule: record.ownerModule,
			recordRef: record.recordRef,
			uploaderAccountId: record.uploaderAccountId,
			scan: record.scan,
			status: record.status,
			description: record.description,
		}).toEqual({
			id: OBJECT_ID,
			storageKey: `${TENANT}/documents.core/${OBJECT_ID}`,
			filename: 'contract.pdf',
			contentType: 'application/pdf',
			ownerModule: 'directory.core',
			recordRef: 'party-4711',
			uploaderAccountId: ACCOUNT,
			scan: 'clean',
			status: 'stored',
			description: 'Signed copy',
		});
		expect(record.bytes).toBe(pdfBytes().byteLength);
		expect(record.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

		const stored = await context.storage.port.stat(objectRef());
		expect(stored?.checksum).toBe(record.checksum);
		expect(await context.repository.storedBytes(TENANT)).toBe(record.bytes);
		expect((await service.list(TENANT)).map((entry) => entry.id)).toEqual([
			OBJECT_ID,
		]);
	});

	it('DOCUMENTS-UPLOAD keeps the declared type the port normalized, not the parameters', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		const record = await service.upload(
			TENANT,
			ACCOUNT,
			upload(pdfBytes(), { contentType: 'Application/PDF; charset=binary' }),
		);
		expect(record.contentType).toBe('application/pdf');
	});

	it('DOCUMENTS-REFUSE refuses a file over the object limit and leaves no row and no object', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(textBytes(context.storage.maxObjectBytes + 1), {
						contentType: 'text/plain',
						filename: 'notes.txt',
					}),
				),
			),
		).toEqual({ code: 'DOCUMENT_TOO_LARGE', status: 413 });
		expect(await context.storage.keys()).toEqual([]);
		expect(await service.list(TENANT)).toEqual([]);
	});

	it('DOCUMENTS-REFUSE refuses a type outside the allowlist and leaves no row and no object', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(executableBytes(), {
						contentType: 'application/octet-stream',
						filename: 'agent.bin',
					}),
				),
			),
		).toEqual({ code: 'CONTENT_TYPE_REFUSED', status: 415 });
		expect(await context.storage.keys()).toEqual([]);
		expect(await service.list(TENANT)).toEqual([]);
	});

	it('DOCUMENTS-REFUSE refuses bytes that do not carry the declared type and leaves no row and no object', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(pngBytes(), { contentType: 'application/pdf' }),
				),
			),
		).toEqual({ code: 'CONTENT_MISMATCH', status: 400 });
		expect(await context.storage.keys()).toEqual([]);
		expect(await service.list(TENANT)).toEqual([]);
	});

	it('DOCUMENTS-REFUSE refuses an upload over the workspace quota before a byte is stored', async () => {
		const body = pdfBytes();
		const service = context.service({
			newId: () => OBJECT_ID,
			quotaBytes: () => body.byteLength - 1,
		});
		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(body, { declaredBytes: body.byteLength }),
				),
			),
		).toEqual({ code: 'QUOTA_EXCEEDED', status: 413 });
		expect(await context.storage.keys()).toEqual([]);
		expect(await service.list(TENANT)).toEqual([]);
	});

	/* "Before a byte is stored" is only proved at the port: a refusal that has
	   already called put stored the object and deleted it afterwards. */
	it('DOCUMENTS-REFUSE never reaches the store when the declared size is over the quota', async () => {
		const body = pdfBytes();
		let puts = 0;
		const service = new DocumentsService({
			repository: context.repository,
			storage: {
				...context.storage.port,
				put: (input) => {
					puts += 1;
					return context.storage.port.put(input);
				},
			},
			quotaBytes: () => body.byteLength - 1,
			readUrlSeconds: () => 300,
			newId: () => OBJECT_ID,
		});

		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(body, { declaredBytes: body.byteLength }),
				),
			),
		).toEqual({ code: 'QUOTA_EXCEEDED', status: 413 });
		expect(puts).toBe(0);
	});

	/* The declared length is the client's claim. A body larger than it is caught
	   after the port read it, and the object it wrote is removed again. */
	it('DOCUMENTS-REFUSE removes the object when the body outgrows the declared size', async () => {
		const body = pdfBytes();
		const service = context.service({
			newId: () => OBJECT_ID,
			quotaBytes: () => body.byteLength - 1,
		});

		expect(
			await refusal(() =>
				service.upload(TENANT, ACCOUNT, upload(body, { declaredBytes: 1 })),
			),
		).toEqual({ code: 'QUOTA_EXCEEDED', status: 413 });
		expect(await context.storage.keys()).toEqual([]);
		expect(await service.list(TENANT)).toEqual([]);
	});

	it('DOCUMENTS-REFUSE counts what is already stored against the quota', async () => {
		const body = pdfBytes();
		const quota = body.byteLength + 1;
		const first = context.service({
			newId: () => OBJECT_ID,
			quotaBytes: () => quota,
		});
		await first.upload(TENANT, ACCOUNT, upload(body));

		const second = context.service({
			newId: () => 'document-0002',
			quotaBytes: () => quota,
		});
		expect(
			await refusal(() => second.upload(TENANT, ACCOUNT, upload(body))),
		).toEqual({ code: 'QUOTA_EXCEEDED', status: 413 });
		expect(
			await context.storage.port.stat(objectRef('document-0002')),
		).toBeNull();
		expect((await second.list(TENANT)).map((entry) => entry.id)).toEqual([
			OBJECT_ID,
		]);
	});

	it('DOCUMENTS-REFUSE deletes an infected object and keeps its row as the trail', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		expect(
			await refusal(() =>
				service.upload(TENANT, ACCOUNT, upload(infectedPdfBytes())),
			),
		).toEqual({ code: 'DOCUMENT_INFECTED', status: 422 });
		expect(await context.storage.keys()).toEqual([]);

		const rows = await service.list(TENANT);
		expect(
			rows.map((entry) => [
				entry.id,
				entry.scan,
				entry.status,
				entry.bytes,
				entry.checksum,
			]),
		).toEqual([[OBJECT_ID, 'infected', 'deleted', 0, null]]);
		/* The trail must never count against what the workspace may still store. */
		expect(await context.repository.storedBytes(TENANT)).toBe(0);
	});

	it('DOCUMENTS-REFUSE rejects a filename carrying a path separator', async () => {
		const service = context.service({ newId: () => OBJECT_ID });
		expect(
			await refusal(() =>
				service.upload(
					TENANT,
					ACCOUNT,
					upload(pdfBytes(), { filename: '../../etc/passwd.pdf' }),
				),
			),
		).toEqual({ code: 'INVALID_INPUT', status: 400 });
		expect(await context.storage.port.stat(objectRef())).toBeNull();
	});
});
