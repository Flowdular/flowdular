import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openImportHarness,
	principal,
	OTHER_TENANT,
	TENANT,
	type ImportTestHarness,
} from './support/harness.ts';
import {
	createFakeImportPort,
	FIVE_ROW_CSV,
	MEMBERS_MAPPING,
	MEMBERS_TARGET,
} from './support/port.ts';

let harness: ImportTestHarness;

beforeAll(async () => {
	harness = await openImportHarness();
	harness.ports.register('users.core', [createFakeImportPort().port]);
	harness.ports.seal();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	await harness.reset();
});

async function jobIn(tenantId: string) {
	const stored = await harness.storeCsv(tenantId, FIVE_ROW_CSV);
	const job = await harness.service.start(principal(undefined, tenantId), {
		target: MEMBERS_TARGET,
		documentId: stored.documentId,
		documentRef: stored.documentRef,
		mode: 'create-only',
		dryRun: true,
		columns: MEMBERS_MAPPING,
	});
	await harness.runner.tick();
	return job;
}

describe('IMPORT-TENANT-BOUNDARY', () => {
	it('shows a workspace only its own jobs, outcomes and mappings', async () => {
		const mine = await jobIn(TENANT);
		const theirs = await jobIn(OTHER_TENANT);
		await harness.service.saveMapping(
			principal(undefined, TENANT),
			MEMBERS_TARGET,
			MEMBERS_MAPPING,
		);

		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items.map(
				(job) => job.id,
			),
		).toEqual([mine.id]);
		expect(await harness.repository.findJob(TENANT, theirs.id)).toBeNull();
		expect(
			(await harness.repository.listJobRows(TENANT, theirs.id, 200)).items,
		).toEqual([]);
		expect(
			(await harness.repository.listJobRows(TENANT, mine.id, 200)).items.length,
		).toBe(5);
		expect(
			await harness.repository.findMapping(OTHER_TENANT, MEMBERS_TARGET),
		).toBeNull();
	});

	it('refuses a row carrying another workspace’s identifier', async () => {
		await expect(
			harness.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO import_jobs
						 (id, tenant_id, target, document_id, document_ref, mode, dry_run,
						  valid_only, status, total_rows, valid_rows, written_rows,
						  failed_rows, requester_account_id, requester_json, columns_json,
						  failure_code, claimed_at, started_at, completed_at)
						 VALUES ('smuggled', $1, 'users.core.members', 'document-1',
						         'reference-1', 'create-only', 0, 0, 'parsing', 0, 0, 0, 0,
						         'account-mallory', '{}', '{}', NULL, NULL, 1, NULL)`,
						parameters: [OTHER_TENANT],
					}),
				{ access: 'write', tenantId: TENANT },
			),
		).rejects.toThrow();
	});

	it('refuses a transaction with no workspace at all on the runtime role', async () => {
		await expect(
			harness.runtime.transaction(
				(transaction) =>
					transaction.query({ text: 'SELECT id FROM import_jobs' }),
				{ access: 'read' },
			),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('lets the routing read see every workspace, in routing columns only', async () => {
		const queued = async (tenantId: string) => {
			const stored = await harness.storeCsv(tenantId, FIVE_ROW_CSV);
			return harness.service.start(principal(undefined, tenantId), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
		};
		const mine = await queued(TENANT);
		const theirs = await queued(OTHER_TENANT);

		const routing = await harness.repository.listPendingJobs(10);
		expect(routing.map((entry) => entry.id).sort()).toEqual(
			[mine.id, theirs.id].sort(),
		);
		expect(new Set(routing.map((entry) => entry.tenantId))).toEqual(
			new Set([TENANT, OTHER_TENANT]),
		);
		/* The routing row carries what the poll needs to claim the job under its
		   own workspace, and nothing the job holds. */
		for (const entry of routing) {
			expect(Object.keys(entry).sort()).toEqual([
				'id',
				'startedAt',
				'status',
				'tenantId',
			]);
		}
	});

	it('refuses the background role every column the routing read does not need', async () => {
		await expect(
			harness.background.query({
				text: 'SELECT document_id FROM import_jobs',
			}),
		).rejects.toThrow();
		await expect(
			harness.background.query({ text: 'SELECT id FROM import_job_rows' }),
		).rejects.toThrow();
		await expect(
			harness.background.query({ text: 'SELECT id FROM import_mappings' }),
		).rejects.toThrow();
	});

	it('never lets the background role write', async () => {
		await expect(
			harness.background.execute({
				text: "UPDATE import_jobs SET status = 'cancelled'",
			}),
		).rejects.toThrow();
	});
});
