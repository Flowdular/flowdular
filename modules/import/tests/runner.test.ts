import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobEvent, JobRunner } from '@flowdular/server';
import type { ImportPort } from '../src/domain/ports.ts';
import type { ImportJob, ImportRowOutcome } from '../src/domain/types.ts';
import { createImportCsvSource } from '../src/services/csv-source.ts';
import { createImportJobRunner } from '../src/services/import-runner.ts';
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
/** Short enough that a renewal lands inside a batch of a test-sized job. */
const BEAT_MS = 20;
const START = 1_700_000_000_000;

let harness: ImportTestHarness;
let clock = START;
let validateCalls = 0;
let writeCalls = 0;
let onValidate: ((call: number) => Promise<void>) | null = null;
let onWrite: ((call: number) => Promise<void>) | null = null;
let waiters: {
	readonly type: JobEvent['type'];
	readonly matches: (event: JobEvent) => boolean;
	readonly resolve: () => void;
}[] = [];

/**
 * Resolves on the next runner event of this type the predicate accepts. Every
 * case that depends on a renewal waits for the renewal itself rather than for a
 * span of wall time, so a slow database cannot make it flake.
 */
function nextEvent(
	type: JobEvent['type'],
	matches: (event: JobEvent) => boolean = () => true,
): Promise<void> {
	return new Promise<void>((resolve) => {
		waiters = [...waiters, { type, matches, resolve }];
	});
}

function observe(event: JobEvent): void {
	const woken = waiters.filter(
		(waiter) => waiter.type === event.type && waiter.matches(event),
	);
	waiters = waiters.filter((waiter) => !woken.includes(waiter));
	for (const waiter of woken) waiter.resolve();
}

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

/**
 * The module's job on the platform runner. `now` is the clock of the process
 * that holds the claim: a case pins it to model a loop whose clock stopped with
 * it, and reads `() => clock` to model one that runs on with the stage.
 */
function runner(now: () => number): JobRunner {
	const resolved = service();
	return createImportJobRunner({
		repository: async () => harness.repository,
		service: async () => resolved,
		claimTimeoutMs: LEASE_MS,
		heartbeatEveryMs: BEAT_MS,
		now,
		onEvent: observe,
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
	waiters = [];
	await harness.reset();
	fake.reset();
});

describe('the job claim', () => {
	it('renews the claim on the runner timer while a stage is running', async () => {
		const job = await start();
		const held: (number | null | undefined)[] = [];
		const renewed = START + 2 * LEASE_MS;
		onValidate = async (call) => {
			if (call !== 1) return;
			/* This batch took longer than the whole lease. */
			clock = renewed;
			await nextEvent('heartbeat', (event) => event.at === renewed);
			held.push((await harness.repository.findJob(TENANT, job.id))?.claimedAt);
		};

		expect(await runner(() => clock).tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});

		/* The claim the rest of the stage runs under is the one the runner renewed
		   on its own timer, not the one it took at the head of the pass. */
		expect(held).toEqual([renewed]);
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
		clock = START + LEASE_MS + LEASE_MS / 2;
		const second = runner(() => clock);
		expect(await second.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});
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
		expect(await second.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
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
			/* The stage waits for the renewal that finds the claim gone; without
			   it the case would race the runner's timer. */
			await nextEvent('claim-lost');
		};

		/* This loop's clock stopped with the process that holds the claim, so its
		   renewals never carry the row out of the stale window the other loop
		   claimed against. */
		expect(await runner(() => START).tick()).toEqual({
			claimed: 1,
			performed: 0,
			failed: 0,
			claimLost: 1,
		});

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
		await runner(() => clock).tick();
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

		/* The process running this batch is gone: its clock stopped with it, so
		   nothing it renews carries the row out of the window below. */
		void runner(() => START).tick();
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
		expect(await runner(() => clock).tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});

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
