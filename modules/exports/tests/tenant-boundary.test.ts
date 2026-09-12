import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExportJob } from '../src/domain/types.ts';
import {
	openExportHarness,
	principal,
	type ExportTestHarness,
	OTHER_TENANT,
	TENANT,
} from './support/harness.ts';
import { createFakeList, members, MEMBERS_LIST } from './support/lists.ts';

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

async function jobIn(tenantId: string): Promise<ExportJob> {
	list.rows.set(tenantId, members(2));
	const started = await harness.service.start(
		principal(undefined, tenantId),
		MEMBERS_LIST,
	);
	await harness.runner.tick();
	return harness.service.job(tenantId, started.id);
}

describe('EXPORTS-TENANT-BOUNDARY', () => {
	it('shows one workspace only its own jobs', async () => {
		const mine = await jobIn(TENANT);
		const theirs = await jobIn(OTHER_TENANT);

		const page = await harness.repository.listJobs(TENANT, { limit: 10 });
		expect(page.items.map((job) => job.id)).toEqual([mine.id]);
		expect(await harness.repository.findJob(TENANT, theirs.id)).toBeNull();
		expect(await harness.repository.findJob(OTHER_TENANT, mine.id)).toBeNull();
	});

	it('keeps one workspace out of the file of another', async () => {
		const mine = await jobIn(TENANT);
		const theirs = await jobIn(OTHER_TENANT);
		/* Each job read its own workspace's rows through its own snapshot. */
		expect(await harness.storedText(TENANT, mine.objectId!)).toContain(
			'member-1@example.com',
		);
		expect(
			await harness.storage.stat({
				tenantId: TENANT,
				moduleId: 'exports.core',
				objectId: theirs.objectId!,
			}),
		).toBeNull();
	});

	it('rejects a row carrying another workspace identifier', async () => {
		await expect(
			harness.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO exports_jobs (id, tenant_id, list_id, status,
						 row_count, byte_count, object_id, requester_account_id,
						 requester_json, failure_code, claimed_at, started_at, completed_at)
						 VALUES ('smuggled', $1, 'users.core.members', 'requested', 0, 0,
						 NULL, 'account-ada', '{}', NULL, NULL, 1, NULL)`,
						parameters: [OTHER_TENANT],
					}),
				{ access: 'write', tenantId: TENANT },
			),
		).rejects.toThrow();
	});

	it('refuses a runtime read with no workspace at all', async () => {
		await expect(
			harness.runtime.transaction(
				(transaction) =>
					transaction.query({ text: 'SELECT id FROM exports_jobs' }),
				{ access: 'read' },
			),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('lets the routing read see every workspace and the routing columns alone', async () => {
		list.rows.set(TENANT, members(1));
		list.rows.set(OTHER_TENANT, members(1));
		await harness.service.start(principal(undefined, TENANT), MEMBERS_LIST);
		await harness.service.start(
			principal(undefined, OTHER_TENANT),
			MEMBERS_LIST,
		);
		const routing = await harness.repository.listPendingJobs(25);
		expect(routing.map((entry) => entry.tenantId).sort()).toEqual(
			[TENANT, OTHER_TENANT].sort(),
		);
		for (const entry of routing) {
			expect(Object.keys(entry).sort()).toEqual([
				'id',
				'startedAt',
				'status',
				'tenantId',
			]);
		}
	});

	it('denies the background role every other column and every write', async () => {
		await jobIn(TENANT);
		await expect(
			harness.background.query({
				text: 'SELECT requester_json FROM exports_jobs',
			}),
		).rejects.toThrow();
		await expect(
			harness.background.query({ text: 'SELECT object_id FROM exports_jobs' }),
		).rejects.toThrow();
		await expect(
			harness.background.execute({
				text: `UPDATE exports_jobs SET status = 'failed'`,
			}),
		).rejects.toThrow();
	});
});
