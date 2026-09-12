import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IMPORT_PERMISSIONS } from '../src/acl/permissions.ts';
import { IMPORT_PORTS_CAPABILITY } from '../src/domain/ports.ts';
import { moduleDefinition } from '../src/index.ts';
import { endpoints } from '../src/api/endpoints.ts';
import type { ImportJobStatus } from '../src/domain/types.ts';
import {
	importDataClass,
	IMPORT_RETENTION_DAYS,
	IMPORT_SWEEP_JOBS,
} from '../src/services/data-classes.ts';
import type {
	ImportRepository,
	ImportSweepInput,
} from '../src/services/repository.ts';
import {
	openImportHarness,
	principal,
	TENANT,
	type ImportTestHarness,
} from './support/harness.ts';
import {
	createFakeImportPort,
	FIVE_ROW_CSV,
	MEMBERS_MAPPING,
	MEMBERS_TARGET,
} from './support/port.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the import module identity', () => {
	it('declares the capability it provides under the id consumers import', () => {
		expect(moduleDefinition.manifest.id).toBe('import.core');
		expect(moduleDefinition.manifest.provides).toContain(
			IMPORT_PORTS_CAPABILITY,
		);
		expect(
			moduleDefinition.manifest.requires?.map((entry) => entry.id),
		).toContain('documents.attachments.v1');
		expect(moduleDefinition.permissions).toEqual([
			'import.jobs.read',
			'import.jobs.manage',
		]);
	});

	it('keeps the manifest version, the package version and the spec aligned', async () => {
		const packageJson = (await import('../package.json', {
			with: { type: 'json' },
		})) as unknown as { default: { version: string } };
		expect(moduleDefinition.manifest.version).toBe(packageJson.default.version);
	});

	it('names every endpoint it serves', () => {
		expect([...endpoints]).toEqual([
			'import.targets.list',
			'import.jobs.list',
			'import.jobs.get',
			'import.jobs.rows',
			'import.jobs.start',
			'import.jobs.continue',
			'import.jobs.cancel',
			'import.mappings.get',
			'import.mappings.save',
		]);
	});
});

describe('the retention pass bound', () => {
	const NOW = 1_700_000_000_000;

	/** What one pass asks the repository for when the platform asks for `limit`. */
	async function asked(limit: number): Promise<ImportSweepInput> {
		const passes: ImportSweepInput[] = [];
		const repository = {
			sweepJobs: async (_tenantId: string, input: ImportSweepInput) => {
				passes.push(input);
				return 0;
			},
		} as unknown as ImportRepository;
		await importDataClass(
			async () => repository,
			() => NOW,
		).sweep!({ tenantId: TENANT, cutoff: new Date(NOW), limit });
		return passes[0]!;
	}

	it('clamps one pass to the module’s own bound whatever it is asked for', async () => {
		expect((await asked(10_000)).limit).toBe(IMPORT_SWEEP_JOBS);
		expect((await asked(IMPORT_SWEEP_JOBS + 1)).limit).toBe(IMPORT_SWEEP_JOBS);
		/* Nothing below one job: a pass that removes nothing never settles the
		   abandoned jobs either, so retention would stop moving. */
		expect((await asked(0)).limit).toBe(1);
		expect((await asked(-5)).limit).toBe(1);
		expect((await asked(1.9)).limit).toBe(1);
		expect((await asked(10)).limit).toBe(10);
	});
});

describe('the import data class', () => {
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

	const settled = async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const job = await harness.service.start(principal(), {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only',
			dryRun: true,
			columns: MEMBERS_MAPPING,
		});
		await harness.runner.tick();
		return job;
	};

	it('declares itself exportable with the retention the spec fixes', () => {
		const declaration = importDataClass(async () => harness.repository);
		expect({
			key: declaration.key,
			retention: declaration.defaultRetentionDays,
			exportable: declaration.exportable,
		}).toEqual({
			key: 'jobs',
			retention: IMPORT_RETENTION_DAYS,
			exportable: true,
		});
		expect(typeof declaration.sweep).toBe('function');
		expect(typeof declaration.export).toBe('function');
	});

	it('exports every record of this workspace and nothing else', async () => {
		const job = await settled();
		await harness.service.saveMapping(
			principal(),
			MEMBERS_TARGET,
			MEMBERS_MAPPING,
		);
		const rows: Record<string, unknown>[] = [];
		const summary = await importDataClass(async () => harness.repository)
			.export!({
			tenantId: TENANT,
			sink: {
				async write(row) {
					rows.push(row);
				},
			},
		});
		/* One job, the five row outcomes it recorded and the saved mapping: the
		   manifest names what the module holds, so the export carries all three. */
		expect(summary.rows).toBe(7);
		expect(rows.find((row) => row['record'] === 'job')).toMatchObject({
			id: job.id,
			target: MEMBERS_TARGET,
		});
		expect(
			rows
				.filter((row) => row['record'] === 'row-outcome')
				.map((row) => row['rowNumber']),
		).toEqual([1, 2, 3, 4, 5]);
		expect(rows.find((row) => row['record'] === 'mapping')).toMatchObject({
			target: MEMBERS_TARGET,
			columns: MEMBERS_MAPPING,
		});
		/* The requester's scope snapshot is internal bookkeeping, never export. */
		expect(rows.some((row) => 'requester' in row)).toBe(false);

		const other = await importDataClass(async () => harness.repository).export!(
			{
				tenantId: 'tenant-nobody',
				sink: { async write() {} },
			},
		);
		expect(other.rows).toBe(0);
	});

	it('sweeps a settled job and its outcomes, and leaves work in flight alone', async () => {
		const done = await settled();
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const running = await harness.service.start(principal(), {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only',
			dryRun: true,
			columns: MEMBERS_MAPPING,
		});

		const declaration = importDataClass(async () => harness.repository);
		const removed = await declaration.sweep!({
			tenantId: TENANT,
			cutoff: new Date(Date.now() + 60_000),
			limit: 100,
		});
		expect(removed.removed).toBe(1);
		expect(await harness.repository.findJob(TENANT, done.id)).toBeNull();
		expect(
			(await harness.repository.listJobRows(TENANT, done.id, 200)).items,
		).toEqual([]);
		expect(await harness.repository.findJob(TENANT, running.id)).not.toBeNull();
	});

	/** A settled job of this workspace, recorded with one outcome row. */
	async function recorded(
		id: string,
		startedAt: number,
		status: ImportJobStatus = 'completed',
	): Promise<void> {
		await harness.repository.createJob({
			id,
			tenantId: TENANT,
			target: MEMBERS_TARGET,
			documentId: 'document-1',
			documentRef: 'import-1',
			mode: 'create-only',
			dryRun: true,
			validOnly: false,
			status,
			totalRows: 1,
			validRows: 1,
			writtenRows: 0,
			failedRows: 0,
			requesterAccountId: 'account-ada',
			requester: {
				accountId: 'account-ada',
				email: 'ada@example.com',
				displayName: 'Ada',
				role: 'owner',
				scopes: [],
			},
			columns: {},
			failureCode: null,
			claimedAt: null,
			startedAt,
			completedAt: status === 'validated' ? null : startedAt + 1,
		});
		await harness.repository.recordJobRows(TENANT, [
			{
				id: `${id}-row-1`,
				tenantId: TENANT,
				jobId: id,
				rowNumber: 1,
				outcome: 'valid',
				field: null,
				reason: null,
				recordRef: null,
			},
		]);
	}

	it('removes one batch of jobs, oldest by started_at and id, with their outcomes', async () => {
		/* One instant for all six, so the tie is what decides the batch. They are
		   recorded newest id first, which is the order a sweep without a
		   tiebreaker reads them in. */
		const startedAt = Date.now() - 60_000;
		for (const id of ['job-6', 'job-5', 'job-4', 'job-3', 'job-2', 'job-1']) {
			await recorded(id, startedAt);
		}

		const removed = await importDataClass(async () => harness.repository)
			.sweep!({
			tenantId: TENANT,
			cutoff: new Date(),
			limit: 3,
		});

		expect(removed.removed).toBe(3);
		const left = await harness.repository.listJobs(TENANT, { limit: 10 });
		expect(left.items.map((job) => job.id).sort()).toEqual([
			'job-4',
			'job-5',
			'job-6',
		]);
		/* Whatever the batch was, no outcome may outlive its job and no job may
		   lose the outcomes it still owns. */
		for (const id of ['job-1', 'job-2', 'job-3']) {
			expect(
				(await harness.repository.listJobRows(TENANT, id, 10)).items,
			).toEqual([]);
		}
		for (const id of ['job-4', 'job-5', 'job-6']) {
			expect(
				(await harness.repository.listJobRows(TENANT, id, 10)).items,
			).toHaveLength(1);
		}
	});

	it('cancels a validated job nobody continued and leaves a fresh one alone', async () => {
		const now = Date.now();
		await recorded('job-abandoned', now - 8 * DAY_MS, 'validated');
		await recorded('job-waiting', now - DAY_MS, 'validated');

		/* A retention cutoff older than either job, so nothing is removed and the
		   expiry is the only thing this pass can do. */
		const removed = await importDataClass(
			async () => harness.repository,
			() => now,
		).sweep!({
			tenantId: TENANT,
			cutoff: new Date(now - 180 * DAY_MS),
			limit: 100,
		});

		expect(removed.removed).toBe(0);
		const abandoned = await harness.repository.findJob(TENANT, 'job-abandoned');
		expect([abandoned?.status, abandoned?.completedAt]).toEqual([
			'cancelled',
			now,
		]);
		expect(
			(await harness.repository.findJob(TENANT, 'job-waiting'))?.status,
		).toBe('validated');

		/* Settled, so retention now reaches it like any other finished job. */
		const swept = await importDataClass(
			async () => harness.repository,
			() => now,
		).sweep!({
			tenantId: TENANT,
			cutoff: new Date(now),
			limit: 100,
		});
		expect(swept.removed).toBe(1);
		expect(
			await harness.repository.findJob(TENANT, 'job-abandoned'),
		).toBeNull();
	});
});
