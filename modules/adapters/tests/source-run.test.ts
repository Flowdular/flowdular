import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS_PERMISSIONS } from '../src/acl/permissions.ts';
import { recordedAnswer } from '../src/domain/recorded.ts';
import type { AdapterJsonObject } from '../src/domain/registry.ts';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import { principal, TENANT } from './support/fakes.ts';
import {
	serviceHarness,
	sourceRegistration,
	SOURCE_FIXTURE,
	SOURCE_ID,
	type ServiceHarness,
} from './support/service.ts';

let database: AdaptersTestDatabase;

beforeAll(async () => {
	database = await openAdaptersTestDatabase();
});

beforeEach(async () => {
	await database.reset();
});

afterAll(async () => {
	await database?.dispose();
});

const owner = principal();

async function refusal(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string') return code;
		throw error;
	}
	throw new Error('The call was not refused.');
}

async function enable(
	harness: ServiceHarness,
	instanceId: string | null = null,
): Promise<void> {
	await harness.service.bind(owner, {
		adapterId: SOURCE_ID,
		instanceId,
		enabled: true,
		mapping: null,
		schedule: null,
	});
}

/* The fake connector answers every page from the recorded fixture, so a case
   that binds an instance still reads the same two pages. */
function answerFromFixture(harness: ServiceHarness): void {
	harness.calls.respond = (call) => ({
		body: recordedAnswer(SOURCE_FIXTURE, call.input as AdapterJsonObject) ?? {},
	});
}

describe('ADAPTERS-SOURCE-RECORDED a source run over the recorded fixture', () => {
	it('pages, maps and writes through the port, and a second run updates by the natural key', async () => {
		const harness = serviceHarness(database);
		await enable(harness);
		const first = await harness.service.start(owner, SOURCE_ID);
		expect(first).toMatchObject({ status: 'queued', trigger: 'manual' });
		await harness.runs().tick();

		const done = await harness.service.run(TENANT, first.id);
		expect(done).toMatchObject({
			status: 'succeeded',
			pages: 2,
			rowsRead: 3,
			rowsCreated: 2,
			rowsUpdated: 0,
			rowsFailed: 1,
			cursor: null,
			errorCode: null,
		});
		const rows = await harness.service.rows(TENANT, first.id, 50, null);
		expect(
			rows.items.map((row) => [
				row.rowIndex,
				row.naturalKey,
				row.outcome,
				row.errorCode,
				row.message,
			]),
		).toEqual([
			[1, 'V1', 'created', null, null],
			[2, null, 'invalid', 'MAPPING_VALUE_INVALID', 'country'],
			[3, 'V3', 'created', null, null],
		]);
		expect([...harness.writer.records.get(TENANT)!.values()]).toEqual([
			{ code: 'V1', name: 'Acme', country: 'PL' },
			{ code: 'V3', name: 'Initech', country: 'DE' },
		]);
		expect(harness.writer.writes.map((write) => write.mode)).toEqual([
			'update-existing',
			'update-existing',
		]);
		expect(harness.meters.recorded).toEqual([
			{ meter: 'adapters.core.rows', amount: 1, sourceRef: `${first.id}:1` },
			{ meter: 'adapters.core.rows', amount: 1, sourceRef: `${first.id}:2` },
		]);

		const second = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, second.id)).toMatchObject({
			status: 'succeeded',
			rowsCreated: 0,
			rowsUpdated: 2,
			rowsFailed: 1,
		});
		expect(harness.writer.records.get(TENANT)!.size).toBe(2);
	});

	it('refuses a start while a run is active, for a disabled adapter, and an unbound adapter outside recorded mode', async () => {
		const harness = serviceHarness(database);
		expect(await refusal(harness.service.start(owner, SOURCE_ID))).toBe(
			'ADAPTER_DISABLED',
		);
		await enable(harness);
		await harness.service.start(owner, SOURCE_ID);
		expect(await refusal(harness.service.start(owner, SOURCE_ID))).toBe(
			'ADAPTER_RUN_ACTIVE',
		);

		const production = serviceHarness(database, { recordedAllowed: false });
		expect(
			await refusal(
				production.service.bind(owner, {
					adapterId: SOURCE_ID,
					instanceId: null,
					enabled: true,
					mapping: null,
					schedule: null,
				}),
			),
		).toBe('ADAPTER_NOT_BOUND');
	});
});

describe('ADAPTERS-RESUME-CRASH a run whose process stops is continued from its cursor', () => {
	it('lets a second runner take the lapsed claim and read only the pages left', async () => {
		const harness = serviceHarness(database);
		answerFromFixture(harness);
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);

		/* Each process writes page one or not, then stops inside page two until
		   the case lets it go on. */
		const gates: (() => void)[] = [];
		const write = harness.writer.writer.write.bind(harness.writer.writer);
		harness.writer.writer.write = async (input) => {
			if (input.rows.some((row) => row.values.code === 'V3')) {
				await new Promise<void>((resolve) => gates.push(resolve));
			}
			return write(input);
		};
		const first = harness.runs();
		const firstPass = first.tick();
		await expect.poll(() => gates.length).toBe(1);
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'running',
			pages: 1,
			cursor: 'c2',
		});
		/* While the lease is live nobody else may take the run. */
		expect(
			await database.repository.claimRun({
				tenantId: TENANT,
				id: run.id,
				claimedBy: 'another-process',
				at: harness.clock + 30_000,
				leaseUntil: harness.clock + 90_000,
			}),
		).toBeNull();

		/* The lease lapses and another process claims the run and reaches page
		   two from the stored cursor. */
		harness.clock += 61_000;
		const second = harness.runs();
		const secondPass = second.tick();
		await expect.poll(() => gates.length).toBe(2);

		/* The stalled first process wakes while the second still holds the run,
		   finds its claim gone and records nothing. */
		gates[0]!();
		await firstPass;
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'running',
			pages: 1,
			rowsRead: 2,
		});

		/* The first process had already handed V3 to the port, so the second
		   meets it by its natural key and updates it: one record, never two. */
		gates[1]!();
		await secondPass;
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'succeeded',
			pages: 2,
			rowsRead: 3,
			rowsCreated: 1,
			rowsUpdated: 1,
		});
		expect(harness.writer.records.get(TENANT)!.size).toBe(2);
		expect(harness.calls.log.map((call) => call.input)).toEqual([
			{ path: '/vendors', query: { limit: 2 } },
			{ path: '/vendors', query: { limit: 2, cursor: 'c2' } },
			{ path: '/vendors', query: { limit: 2, cursor: 'c2' } },
		]);
		expect(
			harness.calls.log.every(
				(call) => call.caller === 'workflow' && call.callerRef === run.id,
			),
		).toBe(true);
		const rows = await harness.service.rows(TENANT, run.id, 50, null);
		expect(rows.items.map((row) => row.outcome)).toEqual([
			'created',
			'invalid',
			'updated',
		]);
		await first.dispose();
		await second.dispose();
	});

	it('settles a run whose last page committed before its process stopped without reading again', async () => {
		const harness = serviceHarness(database);
		answerFromFixture(harness);
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);
		const repository = database.repository;
		const finish = repository.finishRun.bind(repository);
		let release!: () => void;
		let held = false;
		repository.finishRun = async (input) => {
			if (!held) {
				held = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return finish(input);
		};
		try {
			const first = harness.runs();
			const firstPass = first.tick();
			await expect.poll(() => held).toBe(true);
			expect(await harness.service.run(TENANT, run.id)).toMatchObject({
				status: 'running',
				pages: 2,
				cursor: null,
			});
			harness.clock += 61_000;
			const second = harness.runs();
			await second.tick();
			expect(await harness.service.run(TENANT, run.id)).toMatchObject({
				status: 'succeeded',
				pages: 2,
				rowsRead: 3,
			});
			expect(harness.calls.log).toHaveLength(2);
			release();
			await firstPass;
			expect(await harness.service.run(TENANT, run.id)).toMatchObject({
				status: 'succeeded',
				pages: 2,
			});
			await first.dispose();
			await second.dispose();
		} finally {
			delete (repository as { finishRun?: unknown }).finishRun;
		}
	});

	it('stops a running stage at its next page once the run is cancelled', async () => {
		const harness = serviceHarness(database);
		await enable(harness);
		const run = await harness.service.start(owner, SOURCE_ID);
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const write = harness.writer.writer.write.bind(harness.writer.writer);
		let held = false;
		harness.writer.writer.write = async (input) => {
			if (!held && input.rows.some((row) => row.values.code === 'V3')) {
				held = true;
				await stalled;
			}
			return write(input);
		};
		const runner = harness.runs();
		const pass = runner.tick();
		await expect.poll(() => held).toBe(true);
		expect(await harness.service.cancel(owner, run.id)).toMatchObject({
			status: 'cancelled',
		});
		release();
		await pass;
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'cancelled',
			pages: 1,
			errorCode: null,
		});
		expect(
			(await harness.service.rows(TENANT, run.id, 50, null)).items,
		).toHaveLength(2);
		expect(await refusal(harness.service.cancel(owner, run.id))).toBe(
			'ADAPTER_RUN_NOT_ACTIVE',
		);
		await runner.dispose();
	});
});

describe('ADAPTERS-RETRY retries per page and a failed page keeps its cursor', () => {
	it('waits the Retry-After of a 503 and then reads the page', async () => {
		const harness = serviceHarness(database, {
			register: (catalogue) =>
				catalogue.sources.register('vendors.core', [
					sourceRegistration({ paging: undefined }),
				]),
		});
		let attempts = 0;
		harness.calls.respond = (call) => {
			attempts += 1;
			return attempts === 1
				? {
						outcome: 'failed',
						status: 503,
						errorClass: 'response-5xx',
						retryAfterMs: 2_000,
					}
				: {
						body:
							recordedAnswer(SOURCE_FIXTURE, call.input as AdapterJsonObject) ??
							{},
					};
		};
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		expect(harness.sleeps).toEqual([2_000]);
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'succeeded',
			pages: 1,
			rowsRead: 2,
		});
	});

	it('fails after three attempts with the cursor kept, and a resume continues from it', async () => {
		const harness = serviceHarness(database);
		let broken = true;
		harness.calls.respond = (call) => {
			const query = (call.input as { query: { cursor?: string } }).query;
			if (broken && query.cursor === 'c2') {
				return { outcome: 'failed', status: 500, errorClass: 'response-5xx' };
			}
			return {
				body:
					recordedAnswer(SOURCE_FIXTURE, call.input as AdapterJsonObject) ?? {},
			};
		};
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		const failed = await harness.service.run(TENANT, run.id);
		expect(failed).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_CALL_FAILED',
			cursor: 'c2',
			pages: 1,
			rowsRead: 2,
		});
		expect(harness.calls.log).toHaveLength(4);
		/* Full jitter with the random share fixed at a half: 500, then 1000. */
		expect(harness.sleeps).toEqual([250, 500]);

		broken = false;
		const resumed = await harness.service.resume(owner, run.id);
		expect(resumed).toMatchObject({
			trigger: 'resume',
			resumedFrom: run.id,
			cursor: 'c2',
			status: 'queued',
		});
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, resumed.id)).toMatchObject({
			status: 'succeeded',
			pages: 1,
			rowsRead: 1,
			rowsCreated: 1,
		});
		expect(harness.calls.log.at(-1)?.input).toEqual({
			path: '/vendors',
			query: { limit: 2, cursor: 'c2' },
		});
		expect(await refusal(harness.service.resume(owner, run.id))).toBe(
			'ADAPTER_RUN_NOT_RESUMABLE',
		);
	});

	it('does not retry a refusal of the credential', async () => {
		const harness = serviceHarness(database);
		harness.calls.respond = () => ({
			outcome: 'failed',
			status: 401,
			errorClass: 'response-4xx',
		});
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_CALL_UNAUTHORIZED',
			cursor: null,
		});
		expect(harness.calls.log).toHaveLength(1);
		expect(harness.sleeps).toEqual([]);
		expect(await refusal(harness.service.resume(owner, run.id))).toBe(
			'ADAPTER_RUN_NOT_RESUMABLE',
		);
	});
});

describe('ADAPTERS-CONSENT a run without the instance consent calls nothing', () => {
	it('fails with ADAPTER_CONSENT_MISSING before the first call', async () => {
		const harness = serviceHarness(database);
		harness.calls.consent = false;
		await enable(harness, 'instance-erp');
		const run = await harness.service.start(owner, SOURCE_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_CONSENT_MISSING',
		});
		expect(await refusal(harness.service.dryRun(owner, SOURCE_ID, null))).toBe(
			'ADAPTER_CONSENT_MISSING',
		);
		expect(harness.calls.log).toEqual([]);
	});

	it('fails a run whose account lost the grant or the membership', async () => {
		const harness = serviceHarness(database);
		await enable(harness);
		const forbidden = await harness.service.start(owner, SOURCE_ID);
		harness.principals.set(owner.accountId, principal([]));
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, forbidden.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_PRINCIPAL_FORBIDDEN',
		});
		const gone = await harness.service.start(owner, SOURCE_ID);
		harness.principals.delete(owner.accountId);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, gone.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_PRINCIPAL_UNAVAILABLE',
		});
		expect(harness.writer.writes).toEqual([]);
	});
});

describe('ADAPTERS-DRY-RUN a dry run writes nothing', () => {
	it('maps and validates the first page with the mapping in the request', async () => {
		const harness = serviceHarness(database);
		const result = await harness.service.dryRun(owner, SOURCE_ID, [
			{ from: 'id', to: 'code', transform: 'rename' },
			{ from: 'title', to: 'name', transform: 'rename' },
		]);
		expect(result).toEqual({
			read: 2,
			more: true,
			rows: [
				{
					index: 1,
					values: { code: 'V1', name: 'Acme' },
					outcome: 'valid',
					field: null,
					code: null,
				},
				{
					index: 2,
					values: { code: 'V2', name: 'Globex' },
					outcome: 'valid',
					field: null,
					code: null,
				},
			],
		});
		const stored = await harness.service.dryRun(owner, SOURCE_ID, null);
		expect(stored.rows.map((row) => [row.outcome, row.code])).toEqual([
			['valid', null],
			['invalid', 'MAPPING_VALUE_INVALID'],
		]);
		expect(
			await refusal(
				harness.service.dryRun(
					principal([ADAPTERS_PERMISSIONS.read, ADAPTERS_PERMISSIONS.manage]),
					SOURCE_ID,
					null,
				),
			),
		).toBe('ADAPTER_PORT_FORBIDDEN');
		expect(harness.writer.validates).toBe(2);
		expect(harness.writer.writes).toEqual([]);
		expect((await harness.service.runs(TENANT, { limit: 10 })).items).toEqual(
			[],
		);
		expect(
			await refusal(
				harness.service.dryRun(owner, SOURCE_ID, [
					{ from: 'id', to: 'reference', transform: 'rename' },
				]),
			),
		).toBe('MAPPING_INVALID');
	});
});
