import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import {
	documentRendersDataClass,
	documentsDataClass,
	documentTemplatesDataClass,
	documentTextDataClass,
} from '../src/services/data-classes.ts';
import type { DocumentsService } from '../src/services/documents-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes } from './support/files.ts';
import { OFFER_KEY, offerInput, offerRegistry } from './support/templates.ts';

const ACCOUNT = 'account-ada';

let context: DocumentsTestContext;
let documents: DocumentsService;
/* The export orders by creation time, so the clock has to move between two
   uploads for the expected order to mean anything. */
let clock = 1_760_000_000_000;

beforeAll(async () => {
	context = await openDocumentsTestContext({ maxObjectBytes: 4 * 1024 * 1024 });
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

	it('declares the document text beside the documents, kept and excluded from the export', () => {
		const registry = createDataClassRegistry();
		registry.declare('documents.core', [
			declaration(),
			documentTextDataClass(),
		]);
		registry.seal();

		const [, text] =
			registry.list().find((module) => module.moduleId === 'documents.core')
				?.classes ?? [];
		expect(text).toMatchObject({
			key: 'text',
			defaultRetentionDays: null,
			exportable: false,
			excludedReason: expect.stringMatching(/documents class exports/),
		});
		expect(text?.sweep).toBeUndefined();
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

describe('template data classes', () => {
	it('keeps template versions and sweeps settled renders after 90 days, exporting neither input nor secrets', async () => {
		const templates = documentTemplatesDataClass(() =>
			Promise.resolve(context.templates),
		);
		const renders = documentRendersDataClass(() =>
			Promise.resolve(context.templates),
		);
		const registry = createDataClassRegistry();
		registry.declare('documents.core', [templates, renders]);
		registry.seal();
		expect([
			templates.defaultRetentionDays,
			templates.sweep,
			renders.defaultRetentionDays,
		]).toEqual([null, undefined, 90]);

		const service = context.templatesService(offerRegistry(), {
			now: () => (clock += 1_000),
		});
		await service.save('tenant-a', ACCOUNT, {
			key: OFFER_KEY,
			body: 'Zmieniona {{ customer }}',
			layout: {},
			expectedVersion: 0,
		});
		const rendered = await service.render({
			tenantId: 'tenant-a',
			principal: { accountId: ACCOUNT, scopes: ['documents.files.manage'] },
			ownerModule: 'orders.core',
			recordRef: 'order-1',
			templateKey: OFFER_KEY,
			input: offerInput(1),
		});
		const versionRows: Record<string, unknown>[] = [];
		expect(
			(
				await templates.export!({
					tenantId: 'tenant-a',
					sink: { write: async (row) => void versionRows.push(row) },
				})
			).rows,
		).toBe(2);
		expect(
			versionRows.map((row) => [row.templateKey, row.version, row.origin]),
		).toEqual([
			[OFFER_KEY, 1, 'module'],
			[OFFER_KEY, 2, 'edit'],
		]);
		const renderRows: Record<string, unknown>[] = [];
		await renders.export!({
			tenantId: 'tenant-a',
			sink: { write: async (row) => void renderRows.push(row) },
		});
		expect(renderRows).toEqual([
			expect.objectContaining({ id: rendered.jobId, status: 'succeeded' }),
		]);
		expect(renderRows[0]).not.toHaveProperty('input');

		expect(
			await renders.sweep!({
				tenantId: 'tenant-b',
				cutoff: new Date(clock + 1),
				limit: 10,
			}),
		).toEqual({ removed: 0 });
		expect(
			await renders.sweep!({
				tenantId: 'tenant-a',
				cutoff: new Date(clock + 1),
				limit: 10,
			}),
		).toEqual({ removed: 1 });
		expect(
			await context.templates.findRender('tenant-a', rendered.jobId),
		).toBeNull();
	});
});
