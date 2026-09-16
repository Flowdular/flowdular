import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import { PORT_PERMISSION, principal, TENANT } from './support/fakes.ts';
import {
	serviceHarness,
	SINK_ID,
	type ServiceHarness,
} from './support/service.ts';
import { ADAPTERS_PERMISSIONS } from '../src/acl/permissions.ts';

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

function withVendors(harness: ServiceHarness): void {
	harness.list.rows = [
		{ id: '1', code: 'S1', name: 'Acme, "Big"', note: '' },
		{ id: '2', code: 'S2', name: 'Globex', note: 'x' },
		{ id: '3', code: 'S3', name: 'Initech', note: '' },
		{ id: '4', code: 'S4', name: 'Umbrella', note: '' },
		{ id: '5', code: 'S5', name: 'Hooli', note: '' },
	];
}

async function enable(harness: ServiceHarness): Promise<void> {
	await harness.service.bind(owner, {
		adapterId: SINK_ID,
		instanceId: 'instance-crm',
		enabled: true,
		mapping: null,
		schedule: null,
	});
}

describe('ADAPTERS-SINK a sink run pushes the pages of a list export', () => {
	it('pushes every page in batches under an idempotency key and records the rows', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		await enable(harness);
		const run = await harness.service.start(owner, SINK_ID);
		await harness.runs().tick();

		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'succeeded',
			direction: 'sink',
			pages: 3,
			rowsRead: 5,
			rowsCreated: 5,
			rowsFailed: 0,
			cursor: null,
		});
		expect(harness.calls.log.map((call) => call.input)).toEqual([
			{
				path: '/import',
				body: {
					records: [
						{ externalId: 'S1', profile: { name: 'Acme, "Big"' } },
						{ externalId: 'S2', profile: { name: 'Globex' } },
					],
				},
			},
			{
				path: '/import',
				body: {
					records: [
						{ externalId: 'S3', profile: { name: 'Initech' } },
						{ externalId: 'S4', profile: { name: 'Umbrella' } },
					],
				},
			},
			{
				path: '/import',
				body: { records: [{ externalId: 'S5', profile: { name: 'Hooli' } }] },
			},
		]);
		const keys = harness.calls.log.map((call) => call.idempotencyKey);
		expect(
			keys.every((key) => /^adapters:[0-9a-f]{64}:1$/.test(key ?? '')),
		).toBe(true);
		expect(new Set(keys).size).toBe(3);
		expect(
			harness.calls.log.every(
				(call) =>
					call.caller === 'workflow' &&
					call.operation === 'post' &&
					call.instanceId === 'instance-crm' &&
					call.callerRef === run.id,
			),
		).toBe(true);
		const rows = await harness.service.rows(TENANT, run.id, 50, null);
		expect(rows.items.map((row) => [row.rowIndex, row.outcome])).toEqual([
			[1, 'pushed'],
			[2, 'pushed'],
			[3, 'pushed'],
			[4, 'pushed'],
			[5, 'pushed'],
		]);
		expect(harness.meters.recorded.map((entry) => entry.amount)).toEqual([
			2, 2, 1,
		]);
	});

	it('answers a push a reclaimed run repeats from the connectors ledger instead of sending it again', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		await enable(harness);
		const run = await harness.service.start(owner, SINK_ID);

		/* The first process sends the last page and stops before it commits. */
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const call = harness.calls.calls.call.bind(harness.calls.calls);
		const keys: (string | undefined)[] = [];
		let held = false;
		harness.calls.calls.call = async (request) => {
			keys.push(request.idempotencyKey);
			const answer = await call(request);
			const body = request.input as { body: { records: unknown[] } };
			if (!held && body.body.records.length === 1) {
				held = true;
				await stalled;
			}
			return answer;
		};
		const first = harness.runs();
		const firstPass = first.tick();
		await expect.poll(() => held).toBe(true);

		/* The second process signs list cursors with a secret of its own. */
		harness.clock += 61_000;
		harness.list.process = 2;
		const second = harness.runs();
		await second.tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'succeeded',
			pages: 3,
			rowsCreated: 5,
		});
		expect(harness.calls.log).toHaveLength(3);
		expect(keys).toHaveLength(4);
		expect(keys[3]).toBe(keys[2]);

		release();
		await firstPass;
		expect(
			(await harness.service.rows(TENANT, run.id, 50, null)).items,
		).toHaveLength(5);
		await first.dispose();
		await second.dispose();
	});

	it('resumes a failed push under the keys the run began with and sends only what the service refused', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		await enable(harness);
		let refuse = true;
		harness.calls.respond = (call) => {
			const records = (
				call.input as { body: { records: { externalId: string }[] } }
			).body.records;
			if (refuse && records[0]?.externalId === 'S3') {
				return { outcome: 'failed', status: 400, errorClass: 'response-4xx' };
			}
			return { body: { accepted: records.length } };
		};
		const run = await harness.service.start(owner, SINK_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_CALL_FAILED',
			cursor: '2',
			pages: 1,
		});
		expect(harness.calls.log).toHaveLength(2);

		refuse = false;
		const resumed = await harness.service.resume(owner, run.id);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, resumed.id)).toMatchObject({
			status: 'succeeded',
			resumedFrom: run.id,
			pages: 2,
			rowsCreated: 3,
		});
		/* The refused slot is spent, so the page goes out once more under the
		   next slot of the same key, and the first page is never sent again. */
		const sent = harness.calls.log.map((call) => [
			(call.input as { body: { records: { externalId: string }[] } }).body
				.records[0]?.externalId,
			call.idempotencyKey?.slice(-2),
		]);
		expect(sent).toEqual([
			['S1', ':1'],
			['S3', ':1'],
			['S3', ':2'],
			['S5', ':1'],
		]);
		expect(harness.calls.log[1]?.idempotencyKey?.slice(0, -2)).toBe(
			harness.calls.log[2]?.idempotencyKey?.slice(0, -2),
		);
	});

	it('skips to its stored position when the list pages differently after a restart', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		await enable(harness);
		let refuse = true;
		harness.calls.respond = (call) => {
			const records = (
				call.input as { body: { records: { externalId: string }[] } }
			).body.records;
			return refuse && records[0]?.externalId === 'S3'
				? { outcome: 'failed', status: 400, errorClass: 'response-4xx' }
				: { body: {} };
		};
		const run = await harness.service.start(owner, SINK_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'failed',
			cursor: '2',
		});

		refuse = false;
		harness.list.process = 2;
		harness.list.pageSize = 3;
		const resumed = await harness.service.resume(owner, run.id);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, resumed.id)).toMatchObject({
			status: 'succeeded',
			rowsRead: 3,
			rowsCreated: 3,
		});
		const sent = harness.calls.log.map((call) =>
			(
				call.input as { body: { records: { externalId: string }[] } }
			).body.records.map((record) => record.externalId),
		);
		expect(sent).toEqual([['S1', 'S2'], ['S3', 'S4'], ['S3'], ['S4', 'S5']]);
		expect(
			(await harness.service.rows(TENANT, resumed.id, 10, null)).items.map(
				(row) => row.rowIndex,
			),
		).toEqual([3, 4, 5]);
	});

	it('refuses to page the list for an account without its permission', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		await enable(harness);
		harness.principals.set(
			owner.accountId,
			principal([
				ADAPTERS_PERMISSIONS.read,
				ADAPTERS_PERMISSIONS.manage,
				PORT_PERMISSION,
			]),
		);
		const run = await harness.service.start(owner, SINK_ID);
		await harness.runs().tick();
		expect(await harness.service.run(TENANT, run.id)).toMatchObject({
			status: 'failed',
			errorCode: 'ADAPTER_LIST_FORBIDDEN',
		});
		expect(harness.calls.log).toEqual([]);
	});

	it('previews the mapped rows of the first list page in a dry run without pushing', async () => {
		const harness = serviceHarness(database);
		withVendors(harness);
		const result = await harness.service.dryRun(owner, SINK_ID, null);
		expect(result).toEqual({
			read: 2,
			more: true,
			rows: [
				{
					index: 1,
					values: { externalId: 'S1', 'profile.name': 'Acme, "Big"' },
					outcome: 'valid',
					field: null,
					code: null,
				},
				{
					index: 2,
					values: { externalId: 'S2', 'profile.name': 'Globex' },
					outcome: 'valid',
					field: null,
					code: null,
				},
			],
		});
		expect(harness.calls.log).toEqual([]);
	});
});
