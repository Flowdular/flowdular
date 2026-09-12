import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ImportPort } from '../src/domain/ports.ts';
import type { ImportJob, ImportRowOutcome } from '../src/domain/types.ts';
import { createImportCsvSource } from '../src/services/csv-source.ts';
import { ImportRunner } from '../src/services/import-runner.ts';
import { ImportService } from '../src/services/import-service.ts';
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

/** Shorter than a real lease and long enough to be unambiguous in a clock. */
const LEASE_MS = 10_000;
const START = 1_700_000_000_000;

let harness: ImportTestHarness;
let clock = START;
let validateCalls = 0;
let writeCalls = 0;
let onValidate: ((call: number) => Promise<void>) | null = null;
let onWrite: ((call: number) => Promise<void>) | null = null;

const fake = createFakeImportPort();

/* The registry is sealed once, so the port a case needs is this one wrapper
   with the hooks that case sets. Behaviour stays the fake's own. */
const port: ImportPort = {
	...fake.port,
	async validate(input) {
		validateCalls += 1;
		await onValidate?.(validateCalls);
		return fake.port.validate(input);
	},
	async write(input) {
		writeCalls += 1;
		await onWrite?.(writeCalls);
		return fake.port.write(input);
	},
};

/** The module's own service on the harness database, with a clock a case owns. */
function service(): ImportService {
	return new ImportService({
		repository: harness.repository,
		ports: harness.ports,
		source: createImportCsvSource({ attachments: () => harness.attachments }),
		maxRows: () => 50_000,
		batchSize: () => 2,
		now: () => clock,
	});
}

function runner(now: number): ImportRunner {
	const resolved = service();
	return new ImportRunner({
		repository: harness.repository,
		service: async () => resolved,
		claimTimeoutMs: LEASE_MS,
		now: () => now,
	});
}

async function start(body = FIVE_ROW_CSV): Promise<ImportJob> {
	const stored = await harness.storeCsv(TENANT, body);
	return service().start(principal(), {
		target: MEMBERS_TARGET,
		documentId: stored.documentId,
		documentRef: stored.documentRef,
		mode: 'create-only',
		dryRun: false,
		columns: MEMBERS_MAPPING,
	});
}

async function outcomes(
	id: string,
): Promise<readonly (readonly [number, ImportRowOutcome])[]> {
	const page = await harness.repository.listJobRows(TENANT, id, 200);
	return page.items.map((row) => [row.rowNumber, row.outcome]);
}

beforeAll(async () => {
	harness = await openImportHarness({ batchSize: 2 });
	harness.ports.register('users.core', [port]);
	harness.ports.seal();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	onValidate = null;
	onWrite = null;
	validateCalls = 0;
	writeCalls = 0;
	clock = START;
	await harness.reset();
	fake.reset();
});

describe('the job claim', () => {
	it('renews the claim once per batch while a stage is running', async () => {
		const job = await start();
		const held: (number | null | undefined)[] = [];
		onValidate = async () => {
			held.push((await harness.repository.findJob(TENANT, job.id))?.claimedAt);
			/* This batch took longer than the whole lease. */
			clock += 2 * LEASE_MS;
		};

		await runner(START).tick();

		/* Four valid rows at two per batch: the claim the second batch finds is
		   the one the first batch renewed, not the one the runner took. */
		expect(held).toHaveLength(2);
		expect(held[0]).toBe(START);
		expect(held[1]).toBe(START + 2 * LEASE_MS);
		/* A settled job holds no claim at all. */
		expect((await harness.repository.findJob(TENANT, job.id))?.claimedAt).toBe(
			null,
		);
	});

	it('leaves a job whose claim was renewed alone and reclaims one that lapsed', async () => {
		const job = await start();
		await harness.repository.claimJob({
			tenantId: TENANT,
			id: job.id,
			claimedAt: START,
			staleBefore: START - LEASE_MS,
		});

		/* The runner that holds it is alive and renewed a batch ago. */
		expect(
			await harness.repository.heartbeatJob(
				TENANT,
				job.id,
				START + LEASE_MS,
				START,
			),
		).toBe(true);
		const second = runner(START + LEASE_MS + LEASE_MS / 2);
		expect(await second.tick()).toEqual({ examined: 1, performed: 0 });
		expect((await harness.service.job(TENANT, job.id)).status).toBe('parsing');

		/* A renewal naming a claim the row no longer carries changes nothing. */
		expect(
			await harness.repository.heartbeatJob(TENANT, job.id, START + 1, START),
		).toBe(false);

		/* Nothing has renewed it since the claim, so the process that held it is
		   gone and the work is free. */
		expect(
			await harness.repository.heartbeatJob(
				TENANT,
				job.id,
				START,
				START + LEASE_MS,
			),
		).toBe(true);
		expect(await second.tick()).toEqual({ examined: 1, performed: 1 });
		expect((await harness.service.job(TENANT, job.id)).status).toBe(
			'validated',
		);
	});
});

describe('IMPORT-RESUME', () => {
	it('stops a stage whose claim was reclaimed instead of writing on', async () => {
		const job = await start();
		const batches: number[] = [];
		onValidate = async (call) => {
			batches.push(call);
			if (call !== 1) return;
			/* This batch outlasted the lease, and another poll loop took the job
			   over while it ran. */
			clock += 2 * LEASE_MS;
			expect(
				await harness.repository.claimJob({
					tenantId: TENANT,
					id: job.id,
					claimedAt: clock,
					staleBefore: clock - LEASE_MS,
				}),
			).not.toBeNull();
		};

		await runner(START).tick();

		/* The renewal after the first batch matched nothing, so the stage stopped
		   there: no second batch, no outcomes, and the job still parsing for the
		   loop that now owns it. */
		expect(batches).toEqual([1]);
		const left = await harness.service.job(TENANT, job.id);
		expect([left.status, left.totalRows]).toEqual(['parsing', 0]);
		expect(
			(await harness.repository.listJobRows(TENANT, job.id, 200)).items,
		).toEqual([]);
		expect((await harness.repository.findJob(TENANT, job.id))?.claimedAt).toBe(
			clock,
		);
	});

	it('completes a reclaimed write with the counts of the whole job', async () => {
		const job = await start();
		await runner(START).tick();
		await service().continue(principal(), job.id, true);

		let reached = (): void => undefined;
		const secondBatch = new Promise<void>((resolve) => {
			reached = resolve;
		});
		onWrite = async (call) => {
			if (call !== 2) return;
			reached();
			/* The process running this batch is gone: it never answers, never
			   records and never releases the claim it holds. */
			await new Promise<never>(() => undefined);
		};

		void runner(START).tick();
		await secondBatch;
		expect(await outcomes(job.id)).toEqual([
			[1, 'created'],
			[2, 'created'],
			[3, 'valid'],
			[4, 'invalid'],
			[5, 'valid'],
		]);

		onWrite = null;
		clock = START + 2 * LEASE_MS;
		expect(await runner(clock).tick()).toEqual({ examined: 1, performed: 1 });

		const completed = await harness.service.job(TENANT, job.id);
		expect({
			status: completed.status,
			written: completed.writtenRows,
			failed: completed.failedRows,
			total: completed.totalRows,
		}).toEqual({ status: 'completed', written: 4, failed: 1, total: 5 });
		expect(await outcomes(job.id)).toEqual([
			[1, 'created'],
			[2, 'created'],
			[3, 'created'],
			[4, 'invalid'],
			[5, 'created'],
		]);
	});
});
