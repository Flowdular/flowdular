import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CSV_BOM } from '@flowdular/server';
import { EXPORT_RETENTION_DAYS } from '../src/services/data-classes.ts';
import { exportsDataClass } from '../src/services/data-classes.ts';
import type { ExportJob } from '../src/domain/types.ts';
import { ExportService } from '../src/services/export-service.ts';
import type { ExportRepository } from '../src/services/repository.ts';
import {
	openExportHarness,
	principal,
	repositoryWith,
	type ExportTestHarness,
	LIST_PERMISSION,
	OTHER_TENANT,
	TENANT,
} from './support/harness.ts';
import { createFakeList, members, MEMBERS_LIST } from './support/lists.ts';
import { EXPORTS_PERMISSIONS } from '../src/acl/permissions.ts';

let harness: ExportTestHarness;
let list: ReturnType<typeof createFakeList>;

beforeAll(async () => {
	harness = await openExportHarness();
	list = createFakeList();
	harness.lists.register('users.core', [list.definition]);
	harness.lists.seal();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	await harness.reset();
	list.reset();
});

/** Starts an export and runs one poll pass, answering the settled job. */
async function startAndRun(
	rows: number,
	options: { readonly tenantId?: string } = {},
): Promise<ExportJob> {
	const tenantId = options.tenantId ?? TENANT;
	list.rows.set(tenantId, members(rows));
	const started = await harness.service.start(
		principal(undefined, tenantId),
		MEMBERS_LIST,
	);
	await harness.runner.tick();
	return harness.service.job(tenantId, started.id);
}

/**
 * One claimed stage whose repository answers the settle differently, so what
 * happens to a file that was already written is observable. The storage port,
 * the schema and every other statement stay the harness's real ones.
 */
async function performWith(
	overrides: Partial<ExportRepository>,
	rows = 3,
): Promise<ExportJob> {
	const service = new ExportService({
		repository: repositoryWith(harness.repository, overrides),
		lists: harness.lists,
		storage: harness.storage,
		maxRows: () => 100_000,
		maxBytes: () => 50 * 1024 * 1024,
		maxObjectBytes: () => 1_048_576,
	});
	list.rows.set(TENANT, members(rows));
	const started = await service.start(principal(), MEMBERS_LIST);
	const claimed = await harness.repository.claimJob({
		tenantId: TENANT,
		id: started.id,
		claimedAt: Date.now(),
		staleBefore: 0,
	});
	await service.perform(claimed!, new AbortController().signal);
	return harness.service.job(TENANT, started.id);
}

describe('EXPORTS-START', () => {
	it('writes a file with a byte order mark, a header and every row', async () => {
		const job = await startAndRun(5);
		expect(job.status).toBe('completed');
		expect(job.rowCount).toBe(5);
		expect(job.failureCode).toBeNull();
		expect(job.completedAt).not.toBeNull();
		expect(job.objectId).not.toBeNull();

		const text = await harness.storedText(TENANT, job.objectId!);
		expect(text.startsWith(CSV_BOM)).toBe(true);
		const records = text.slice(CSV_BOM.length).split('\r\n');
		expect(records[0]).toBe('E-mail,Name,Joined');
		expect(records[1]).toBe(
			'member-1@example.com,Member 1,2026-01-02T00:00:00.000Z',
		);
		expect(records[5]).toBe(
			'member-5@example.com,Member 5,2026-01-06T00:00:00.000Z',
		);
		/* Every record is terminated, so the split ends on an empty tail. */
		expect(records[6]).toBe('');
		expect(job.byteCount).toBe(Buffer.byteLength(text, 'utf8'));
	});

	it('writes the header alone for a list with no rows', async () => {
		const job = await startAndRun(0);
		expect(job.status).toBe('completed');
		expect(job.rowCount).toBe(0);
		expect(await harness.storedText(TENANT, job.objectId!)).toBe(
			CSV_BOM + 'E-mail,Name,Joined\r\n',
		);
	});

	it('reads the list under the requester the job was started by', async () => {
		await startAndRun(3);
		expect(list.calls.length).toBeGreaterThan(0);
		for (const call of list.calls) {
			expect(call.principal.tenantId).toBe(TENANT);
			expect(call.principal.accountId).toBe('account-ada');
			expect(call.principal.scopes).toContain(LIST_PERMISSION);
		}
	});

	it('claims a requested job once, so a second pass finds nothing', async () => {
		list.rows.set(TENANT, members(2));
		await harness.service.start(principal(), MEMBERS_LIST);
		expect(await harness.runner.tick()).toMatchObject({
			claimed: 1,
			performed: 1,
			failed: 0,
		});
		expect(await harness.runner.tick()).toMatchObject({
			claimed: 0,
			performed: 0,
		});
	});
});

describe('EXPORTS-LIST-PERMISSION', () => {
	it('refuses a start without the permission the list declares', async () => {
		const actor = principal([
			EXPORTS_PERMISSIONS.read,
			EXPORTS_PERMISSIONS.manage,
		]);
		await expect(
			harness.service.start(actor, MEMBERS_LIST),
		).rejects.toMatchObject({ code: 'EXPORT_LIST_FORBIDDEN', status: 403 });
		/* No job proceeds because no job exists at all. */
		const page = await harness.repository.listJobs(TENANT, { limit: 10 });
		expect(page.items).toEqual([]);
		expect(list.calls).toEqual([]);
	});
});

describe('EXPORTS-UNKNOWN-LIST', () => {
	it('refuses a start for a list no module registered', async () => {
		await expect(
			harness.service.start(principal(), 'nobody.core.rows'),
		).rejects.toMatchObject({ code: 'EXPORT_LIST_UNKNOWN', status: 404 });
		const page = await harness.repository.listJobs(TENANT, { limit: 10 });
		expect(page.items).toEqual([]);
	});
});

describe('EXPORTS-ROW-BOUND', () => {
	it('fails a list longer than maxRows and stores no file', async () => {
		const own = await openExportHarness({ maxRows: 10 });
		const bounded = createFakeList();
		try {
			own.lists.register('users.core', [bounded.definition]);
			own.lists.seal();
			bounded.rows.set(TENANT, members(11));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_ROWS_EXCEEDED');
			expect(job.objectId).toBeNull();
			expect(job.rowCount).toBe(0);
			expect(await own.storedKeys()).toEqual([]);
		} finally {
			await own.dispose();
		}
	});

	it('completes a list that fills maxRows exactly', async () => {
		const own = await openExportHarness({ maxRows: 10 });
		const bounded = createFakeList();
		try {
			own.lists.register('users.core', [bounded.definition]);
			own.lists.seal();
			bounded.rows.set(TENANT, members(10));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('completed');
			expect(job.rowCount).toBe(10);
		} finally {
			await own.dispose();
		}
	});
});

describe('EXPORTS-BYTE-BOUND', () => {
	it('fails a list past maxBytes and stores no file', async () => {
		const own = await openExportHarness({ maxBytes: 2_048 });
		const bounded = createFakeList({ padding: 200 });
		try {
			own.lists.register('users.core', [bounded.definition]);
			own.lists.seal();
			bounded.rows.set(TENANT, members(50));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_BYTES_EXCEEDED');
			expect(job.objectId).toBeNull();
			expect(await own.storedKeys()).toEqual([]);
		} finally {
			await own.dispose();
		}
	});

	/* The ceiling is the bound that applies, so it applies before the walk: a
	   list read to its end for a file the port was always going to refuse is
	   work nobody asked for. */
	it('stops the walk at the storage object ceiling below maxBytes', async () => {
		const own = await openExportHarness({
			maxBytes: 10 * 1024 * 1024,
			maxObjectBytes: 2_048,
		});
		const bounded = createFakeList({ padding: 200 });
		try {
			own.lists.register('users.core', [bounded.definition]);
			own.lists.seal();
			bounded.rows.set(TENANT, members(500));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_BYTES_EXCEEDED');
			/* Five hundred rows are three pages of the list; the ceiling is crossed
			   inside the first one. */
			expect(bounded.calls).toHaveLength(1);
			expect(await own.storedKeys()).toEqual([]);
		} finally {
			await own.dispose();
		}
	});

	/* The storage port carries its own object ceiling underneath maxBytes. An
	   operator sees one bound, not two, so the refusal reads the same. */
	it('reports the storage object ceiling as the same bound', async () => {
		const own = await openExportHarness({
			maxBytes: 10 * 1024 * 1024,
			maxObjectBytes: 2_048,
		});
		const bounded = createFakeList({ padding: 200 });
		try {
			own.lists.register('users.core', [bounded.definition]);
			own.lists.seal();
			bounded.rows.set(TENANT, members(50));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_BYTES_EXCEEDED');
			expect(await own.storedKeys()).toEqual([]);
		} finally {
			await own.dispose();
		}
	});
});

describe('a list that breaks its contract', () => {
	it('fails the job with one stable code when the list raises', async () => {
		const own = await openExportHarness();
		const broken = createFakeList({ throws: true });
		try {
			own.lists.register('users.core', [broken.definition]);
			own.lists.seal();
			broken.rows.set(TENANT, members(3));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_LIST_FAILED');
		} finally {
			await own.dispose();
		}
	});

	it('fails the job rather than walking a list that never advances', async () => {
		const own = await openExportHarness();
		const stalled = createFakeList({ stalls: true });
		try {
			own.lists.register('users.core', [stalled.definition]);
			own.lists.seal();
			stalled.rows.set(TENANT, members(3));
			const started = await own.service.start(principal(), MEMBERS_LIST);
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect(job.status).toBe('failed');
			expect(job.failureCode).toBe('EXPORT_LIST_STALLED');
			/* The walk stopped at the second page rather than looping. */
			expect(stalled.calls.length).toBe(2);
		} finally {
			await own.dispose();
		}
	});
});

/* A file the job row does not name is an object nothing can ever reach: no
   read resolves it, no sweep is given its id, and the workspace is billed for
   it forever. Every way a stage can end that way is covered here. */
describe('a stage that cannot record the file it wrote', () => {
	it('discards the file when the completing settle raises', async () => {
		const job = await performWith({
			settleJob: async (tenantId, id, input) => {
				if (input.status === 'completed') {
					throw new Error('the settle went down');
				}
				return harness.repository.settleJob(tenantId, id, input);
			},
		});

		expect(job.status).toBe('failed');
		expect(job.failureCode).toBe('JOB_FAILED');
		expect(job.objectId).toBeNull();
		expect(await harness.storedKeys()).toEqual([]);
	});

	it('discards the file when the claim changed hands before the settle', async () => {
		const job = await performWith({
			settleJob: async (tenantId, id, input) =>
				input.status === 'completed'
					? null
					: harness.repository.settleJob(tenantId, id, input),
		});

		/* The stage settled nothing and left the job to whoever holds it now. */
		expect(job.status).toBe('running');
		expect(job.objectId).toBeNull();
		expect(await harness.storedKeys()).toEqual([]);
	});
});

describe('EXPORTS-READ-URL', () => {
	it('answers a signed platform route for a completed job', async () => {
		const job = await startAndRun(2);
		const url = await harness.service.readUrl(principal(), job.id);
		expect(url.startsWith('/api/storage/objects/')).toBe(true);
		/* The route is minted per request and never recorded on the job. */
		expect(
			JSON.stringify(await harness.service.job(TENANT, job.id)),
		).not.toContain(url);
	});

	it('refuses the file to a reader without the exported list permission', async () => {
		const job = await startAndRun(2);
		const reader = principal([
			EXPORTS_PERMISSIONS.read,
			EXPORTS_PERMISSIONS.manage,
		]);
		await expect(harness.service.readUrl(reader, job.id)).rejects.toMatchObject(
			{ code: 'EXPORT_LIST_FORBIDDEN', status: 403 },
		);
	});

	it('refuses a job that has no file yet', async () => {
		list.rows.set(TENANT, members(1));
		const started = await harness.service.start(principal(), MEMBERS_LIST);
		await expect(
			harness.service.readUrl(principal(), started.id),
		).rejects.toMatchObject({ code: 'EXPORT_NOT_READY', status: 409 });
	});

	it('answers a job in another workspace as missing', async () => {
		const job = await startAndRun(1);
		await expect(
			harness.service.readUrl(principal(undefined, OTHER_TENANT), job.id),
		).rejects.toMatchObject({ code: 'EXPORT_JOB_NOT_FOUND', status: 404 });
	});

	it('answers a file retention already removed as gone', async () => {
		const job = await startAndRun(1);
		await harness.storage.delete({
			tenantId: TENANT,
			moduleId: 'exports.core',
			objectId: job.objectId!,
		});
		await expect(
			harness.service.readUrl(principal(), job.id),
		).rejects.toMatchObject({ code: 'EXPORT_OBJECT_GONE', status: 404 });
	});
});

describe('EXPORTS-RETENTION', () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	it('removes the storage object and the job row together', async () => {
		const job = await startAndRun(3);
		expect(await harness.storedKeys()).toHaveLength(1);

		const declaration = exportsDataClass(
			async () => harness.repository,
			async () => harness.service,
		);
		expect(declaration.key).toBe('jobs');
		expect(declaration.defaultRetentionDays).toBe(EXPORT_RETENTION_DAYS);
		const swept = await declaration.sweep!({
			tenantId: TENANT,
			cutoff: new Date(job.startedAt + DAY_MS),
			limit: 500,
		});
		expect(swept).toEqual({ removed: 1 });
		expect(await harness.storedKeys()).toEqual([]);
		await expect(harness.service.job(TENANT, job.id)).rejects.toMatchObject({
			code: 'EXPORT_JOB_NOT_FOUND',
		});
	});

	it('deletes the file before the row that names it', async () => {
		const job = await startAndRun(3);
		let storedWhenRowsWent: readonly string[] = [];
		const declaration = exportsDataClass(
			async () =>
				repositoryWith(harness.repository, {
					deleteJobs: async (tenantId, ids) => {
						storedWhenRowsWent = await harness.storedKeys();
						return harness.repository.deleteJobs(tenantId, ids);
					},
				}),
			async () => harness.service,
		);

		await declaration.sweep!({
			tenantId: TENANT,
			cutoff: new Date(job.startedAt + DAY_MS),
			limit: 500,
		});

		/* A row naming a file that is gone is answered as gone and removed by the
		   next pass; a file outliving its row is one no pass is ever given the id
		   of. The order is the difference between the two. */
		expect(storedWhenRowsWent).toEqual([]);
		expect(await harness.storedKeys()).toEqual([]);
	});

	it('leaves a job inside its retention and a job still running alone', async () => {
		const kept = await startAndRun(1);
		list.rows.set(TENANT, members(1));
		const running = await harness.service.start(principal(), MEMBERS_LIST);
		const declaration = exportsDataClass(
			async () => harness.repository,
			async () => harness.service,
		);
		expect(
			await declaration.sweep!({
				tenantId: TENANT,
				cutoff: new Date(kept.startedAt - DAY_MS),
				limit: 500,
			}),
		).toEqual({ removed: 0 });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items.map(
				(job) => job.id,
			),
		).toEqual(expect.arrayContaining([kept.id, running.id]));
	});

	it('exports the job metadata without the requester snapshot', async () => {
		const job = await startAndRun(2);
		const written: Record<string, unknown>[] = [];
		const declaration = exportsDataClass(
			async () => harness.repository,
			async () => harness.service,
		);
		const summary = await declaration.export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					written.push(row);
				},
			},
		});
		expect(summary.rows).toBe(1);
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({
			record: 'job',
			id: job.id,
			listId: MEMBERS_LIST,
			status: 'completed',
			rowCount: 2,
			requesterAccountId: 'account-ada',
		});
		const serialized = JSON.stringify(written[0]);
		expect(serialized).not.toContain('requester_json');
		expect(serialized).not.toContain('ada@example.com');
		expect(serialized).not.toContain(job.objectId);
	});
});
