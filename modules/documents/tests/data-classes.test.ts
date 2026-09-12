import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import { documentsDataClass } from '../src/services/data-classes.ts';
import type { DocumentsService } from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes } from './support/files.ts';

const ACCOUNT = 'account-ada';

let context: DocumentsTestContext;
let documents: DocumentsService;
/* The export orders by creation time, so the clock has to move between two
   uploads for the expected order to mean anything. */
let clock = 1_760_000_000_000;

beforeAll(async () => {
	context = await openDocumentsTestContext();
	documents = context.service({ now: () => (clock += 1_000) });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function upload(tenantId: string, filename: string) {
	return documents.upload(tenantId, ACCOUNT, {
		ownerModule: 'directory.core',
		recordRef: 'party-4711',
		filename,
		contentType: 'application/pdf',
		body: pdfBytes(filename),
	});
}

function declaration() {
	return documentsDataClass(() => Promise.resolve(documents));
}

describe('documents data class', () => {
	it('declares one class the platform registry accepts', () => {
		const registry = createDataClassRegistry();
		registry.declare('documents.core', [declaration()]);
		registry.seal();

		const entry = registry
			.list()
			.find((module) => module.moduleId === 'documents.core');
		expect(entry?.classes.map((declared) => declared.key)).toEqual([
			'documents',
		]);
		/* A document leaves only when a person or its owning module deletes it,
		   so the class carries no retention period and no sweep. */
		expect(entry?.classes[0]?.defaultRetentionDays).toBeNull();
		expect(entry?.classes[0]?.sweep).toBeUndefined();
		expect(entry?.classes[0]?.exportable).toBe(true);
	});

	it('exports the rows of one workspace, the deleted trail included', async () => {
		const kept = await upload('tenant-a', 'alpha.pdf');
		const removed = await upload('tenant-a', 'gamma.pdf');
		await documents.remove('tenant-a', removed.id);
		await upload('tenant-b', 'beta.pdf');

		const rows: Record<string, unknown>[] = [];
		const summary = await declaration().export!({
			tenantId: 'tenant-a',
			sink: { write: async (row) => void rows.push(row) },
		});

		expect(rows.map((row) => [row.filename, row.status])).toEqual([
			['alpha.pdf', 'stored'],
			['gamma.pdf', 'deleted'],
		]);
		expect(rows[0]).toMatchObject({
			id: kept.id,
			ownerModule: 'directory.core',
			recordRef: 'party-4711',
			storageKey: kept.storageKey,
		});
		expect(summary.rows).toBe(2);
		expect(summary.from).toBeInstanceOf(Date);
		expect(summary.to).toBeInstanceOf(Date);
	});

	it('reports an empty workspace without writing a row', async () => {
		const rows: unknown[] = [];
		const summary = await declaration().export!({
			tenantId: 'tenant-empty',
			sink: { write: async (row) => void rows.push(row) },
		});
		expect(rows).toEqual([]);
		expect(summary).toEqual({ rows: 0, from: null, to: null });
	});
});
