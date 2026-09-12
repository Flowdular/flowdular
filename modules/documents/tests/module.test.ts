import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { DOCUMENTS_ATTACHMENTS_CAPABILITY } from '../src/domain/attachments.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes } from './support/files.ts';

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

describe('documents.core', () => {
	it('exports its validated identity and the capability it provides', () => {
		expect(moduleDefinition.manifest.id).toBe('documents.core');
		expect(moduleDefinition.manifest.provides).toEqual([
			DOCUMENTS_ATTACHMENTS_CAPABILITY,
		]);
	});

	/* The runtime role holds no BYPASSRLS, so the isolation below is enforced by
	   the database rather than by the predicate alone. */
	it('isolates documents by the trusted tenant id', async () => {
		const documents = context.service();
		const upload = (tenantId: string, filename: string) =>
			documents.upload(tenantId, 'account-ada', {
				ownerModule: 'directory.core',
				recordRef: 'party-4711',
				filename,
				contentType: 'application/pdf',
				body: pdfBytes(filename),
			});
		await upload('tenant-a', 'alpha.pdf');
		await upload('tenant-b', 'beta.pdf');

		expect(
			(await documents.list('tenant-a')).map((entry) => entry.filename),
		).toEqual(['alpha.pdf']);
		expect(
			(await documents.list('tenant-b')).map((entry) => entry.filename),
		).toEqual(['beta.pdf']);
	});

	/* No scanner is configured by default, so an object is stored and labelled
	   unscanned rather than refused. */
	it('labels a document unscanned when the deployment configured no scanner', async () => {
		const record = await context.service().upload('tenant-a', 'account-ada', {
			ownerModule: 'directory.core',
			recordRef: 'party-4711',
			filename: 'contract.pdf',
			contentType: 'application/pdf',
			body: pdfBytes(),
		});
		expect([record.scan, record.status]).toEqual(['unscanned', 'stored']);
	});
});
