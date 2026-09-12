import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openStorageReadToken,
	StorageError,
	STORAGE_READ_ROUTE_PREFIX,
} from '@flowdular/storage';
import {
	DocumentsService,
	DocumentsServiceError,
} from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { infectedPdfBytes, pdfBytes } from './support/files.ts';
import { markerScanner } from './support/storage.ts';

const TENANT = 'tenant-a';
const ACCOUNT = 'account-ada';
const READ_URL_SECONDS = 300;

let context: DocumentsTestContext;
/* The port mints the read token against this clock, so a test can stand past a
   token's lifetime without waiting for it. */
let clock = new Date('2026-09-11T10:00:00.000Z');

beforeAll(async () => {
	context = await openDocumentsTestContext({
		scanner: markerScanner,
		clock: () => clock,
	});
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	clock = new Date('2026-09-11T10:00:00.000Z');
	await context.reset();
});

function service() {
	return context.service({ readUrlSeconds: () => READ_URL_SECONDS });
}

function upload(body: Uint8Array, filename = 'contract.pdf') {
	return {
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename,
		contentType: 'application/pdf',
		body,
	};
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof DocumentsServiceError) {
			return `${error.code} ${error.status}`;
		}
		throw error;
	}
	throw new Error('The call was expected to be refused.');
}

function tokenOf(url: string): string {
	expect(url.startsWith(STORAGE_READ_ROUTE_PREFIX)).toBe(true);
	return url.slice(STORAGE_READ_ROUTE_PREFIX.length);
}

describe('documents read url', () => {
	it('DOCUMENTS-READ-URL issues a signed link that names the stored object', async () => {
		const documents = service();
		const record = await documents.upload(TENANT, ACCOUNT, upload(pdfBytes()));

		const read = await documents.readUrl(TENANT, record.id);
		expect(read.expiresInSeconds).toBe(READ_URL_SECONDS);
		expect(
			openStorageReadToken(context.storage.keyring, tokenOf(read.url), clock),
		).toMatchObject({
			tenantId: TENANT,
			moduleId: 'documents.core',
			objectId: record.id,
		});

		const stored = await context.storage.port.get({
			tenantId: TENANT,
			moduleId: 'documents.core',
			objectId: record.id,
		});
		expect(stored?.object.contentType).toBe('application/pdf');
		expect(Buffer.from(await new Response(stored!.body).arrayBuffer())).toEqual(
			Buffer.from(pdfBytes()),
		);
	});

	it('DOCUMENTS-READ-URL stops resolving once the lifetime has passed', async () => {
		const documents = service();
		const record = await documents.upload(TENANT, ACCOUNT, upload(pdfBytes()));
		const token = tokenOf((await documents.readUrl(TENANT, record.id)).url);

		const before = new Date(clock.getTime() + (READ_URL_SECONDS - 1) * 1_000);
		const after = new Date(clock.getTime() + (READ_URL_SECONDS + 1) * 1_000);
		expect(
			openStorageReadToken(context.storage.keyring, token, before),
		).not.toBeNull();
		expect(
			openStorageReadToken(context.storage.keyring, token, after),
		).toBeNull();
	});

	it('DOCUMENTS-READ-URL refuses an infected document', async () => {
		const documents = service();
		await refusalCode(() =>
			documents.upload(TENANT, ACCOUNT, upload(infectedPdfBytes())),
		);
		const [trail] = await documents.list(TENANT);

		expect(await refusalCode(() => documents.readUrl(TENANT, trail!.id))).toBe(
			'DOCUMENT_INFECTED 409',
		);
	});

	it('DOCUMENTS-READ-URL refuses a deleted document and an unknown id', async () => {
		const documents = service();
		const record = await documents.upload(TENANT, ACCOUNT, upload(pdfBytes()));
		await documents.remove(TENANT, record.id);

		expect(await refusalCode(() => documents.readUrl(TENANT, record.id))).toBe(
			'DOCUMENT_DELETED 409',
		);
		expect(await refusalCode(() => documents.readUrl(TENANT, 'missing'))).toBe(
			'DOCUMENT_NOT_FOUND 404',
		);
	});

	/* The order is only observable when the first step fails: a row marked
	   deleted before the object left would survive its own bytes. */
	it('DOCUMENTS-READ-URL keeps the row stored when the object cannot be deleted', async () => {
		const documents = service();
		const record = await documents.upload(TENANT, ACCOUNT, upload(pdfBytes()));
		const refusing = new DocumentsService({
			repository: context.repository,
			storage: {
				...context.storage.port,
				delete: () =>
					Promise.reject(
						new StorageError('STORAGE_UNAVAILABLE', 'The store is down.'),
					),
			},
			quotaBytes: () => 10 * 1024 * 1024,
			readUrlSeconds: () => READ_URL_SECONDS,
		});

		await expect(refusing.remove(TENANT, record.id)).rejects.toBeInstanceOf(
			StorageError,
		);
		expect((await context.repository.find(TENANT, record.id))?.status).toBe(
			'stored',
		);
	});

	it('DOCUMENTS-READ-URL deletes the object before the row so no row outlives its bytes', async () => {
		const documents = service();
		const record = await documents.upload(TENANT, ACCOUNT, upload(pdfBytes()));
		const reference = {
			tenantId: TENANT,
			moduleId: 'documents.core',
			objectId: record.id,
		};
		expect(await context.storage.port.stat(reference)).not.toBeNull();

		const deleted = await documents.remove(TENANT, record.id);
		expect(deleted.status).toBe('deleted');
		expect(await context.storage.port.stat(reference)).toBeNull();
		/* A delete on purpose leaves the lists; only the trail row survives. */
		expect(await documents.list(TENANT)).toEqual([]);
		expect(await context.repository.find(TENANT, record.id)).not.toBeNull();
	});
});
