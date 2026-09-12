import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openStorageReadToken,
	STORAGE_READ_ROUTE_PREFIX,
} from '@flowdular/storage';
import { DocumentsServiceError } from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes } from './support/files.ts';

const ACCOUNT = 'account-ada';

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

function upload(tenantId: string, filename: string) {
	return context.service().upload(tenantId, ACCOUNT, {
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename,
		contentType: 'application/pdf',
		body: pdfBytes(filename),
	});
}

describe('documents tenant boundary', () => {
	it('DOCUMENTS-TENANT-BOUNDARY shows a workspace only its own rows', async () => {
		await upload('tenant-a', 'alpha.pdf');
		await upload('tenant-b', 'beta.pdf');
		const documents = context.service();

		expect(
			(await documents.list('tenant-a')).map((entry) => entry.filename),
		).toEqual(['alpha.pdf']);
		expect(
			(await documents.list('tenant-b')).map((entry) => entry.filename),
		).toEqual(['beta.pdf']);
		expect(await context.repository.storedBytes('tenant-a')).toBe(
			pdfBytes('alpha.pdf').byteLength,
		);
	});

	it('DOCUMENTS-TENANT-BOUNDARY refuses a foreign id on every operation', async () => {
		const foreign = await upload('tenant-b', 'beta.pdf');
		const documents = context.service();

		for (const run of [
			() => documents.readUrl('tenant-a', foreign.id),
			() => documents.remove('tenant-a', foreign.id),
		]) {
			await expect(run()).rejects.toBeInstanceOf(DocumentsServiceError);
		}
		expect(
			(await context.repository.find('tenant-b', foreign.id))?.status,
		).toBe('stored');
	});

	it('DOCUMENTS-TENANT-BOUNDARY keeps the objects apart by the key prefix', async () => {
		const alpha = await upload('tenant-a', 'alpha.pdf');
		expect(alpha.storageKey.startsWith('tenant-a/')).toBe(true);

		/* The same object id under another workspace is another key, so the
		   neighbour's object is not there to be read. */
		expect(
			await context.storage.port.stat({
				tenantId: 'tenant-b',
				moduleId: 'documents.core',
				objectId: alpha.id,
			}),
		).toBeNull();
	});

	it('DOCUMENTS-TENANT-BOUNDARY seals the workspace into the read token', async () => {
		const alpha = await upload('tenant-a', 'alpha.pdf');
		const read = await context.service().readUrl('tenant-a', alpha.id);
		const token = read.url.slice(STORAGE_READ_ROUTE_PREFIX.length);

		/* A token is a capability for one object of one workspace: presenting it
		   elsewhere cannot name another workspace's object, because the tenant is
		   sealed inside it rather than taken from the request. */
		expect(
			openStorageReadToken(context.storage.keyring, token, new Date()),
		).toMatchObject({ tenantId: 'tenant-a', objectId: alpha.id });
	});
});
