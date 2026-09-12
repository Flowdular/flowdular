import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DataClassDeclaration } from '@flowdular/kernel';
import {
	CALL_RETENTION_DAYS,
	connectorsDataClasses,
} from '../src/services/data-classes.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
	callService,
	instanceService,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testResolver,
	testVault,
	type TestServer,
} from './support/harness.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

let shared: ConnectorsTestDatabase;
let server: TestServer;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	server = await startTestServer(() => ({ body: '{"ok":true}' }));
});

afterAll(async () => {
	await server?.close();
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function classes(): readonly DataClassDeclaration[] {
	return connectorsDataClasses(async () => shared.repository, 2);
}

function declaration(key: string): DataClassDeclaration {
	const found = classes().find((entry) => entry.key === key);
	if (!found) throw new Error(`No data class ${key}.`);
	return found;
}

async function collect(
	key: string,
	tenantId: string,
): Promise<readonly Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	const summary = await declaration(key).export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	expect(summary.rows).toBe(rows.length);
	return rows;
}

/** One call of one workspace, recorded at the given time. */
async function recordCall(tenantId: string, occurredAt: number): Promise<void> {
	await shared.repository.recordCall(
		{
			id: `call-${tenantId}-${occurredAt}`,
			tenantId,
			instanceId: 'instance-x',
			operation: 'get',
			caller: 'test',
			callerRef: null,
			outcome: 'succeeded',
			status: 200,
			errorClass: null,
			durationMs: 5,
			requestBytes: 0,
			responseBytes: 11,
			occurredAt,
		},
		null,
	);
}

describe('connectors data classes', () => {
	it('declares the classes the module owns with their retention', () => {
		expect(
			classes().map((entry) => [
				entry.key,
				entry.defaultRetentionDays,
				entry.exportable,
				entry.sweep !== undefined,
			]),
		).toEqual([
			['calls', CALL_RETENTION_DAYS, true, true],
			['audit', null, true, false],
			['instances', null, true, false],
		]);
		expect(CALL_RETENTION_DAYS).toBe(400);
	});

	it('sweeps only the calls of the workspace it was asked about', async () => {
		const old = Date.now() - 500 * DAY_MS;
		await recordCall('tenant-a', old);
		await recordCall('tenant-a', Date.now());
		await recordCall('tenant-b', old);

		const removed = await declaration('calls').sweep!({
			tenantId: 'tenant-a',
			cutoff: new Date(Date.now() - CALL_RETENTION_DAYS * DAY_MS),
			limit: 100,
		});
		expect(removed).toEqual({ removed: 1 });

		const vault = testVault();
		const service = instanceService(shared.repository, vault);
		expect(
			(await service.listCalls('tenant-a')).map((call) => call.occurredAt),
		).toEqual([expect.any(Number)]);
		/* The other workspace keeps the row that was equally old until it is
		   swept under its own name, so the cutoff alone removes nothing. */
		expect(await service.listCalls('tenant-b')).toHaveLength(1);
		expect(
			await declaration('calls').sweep!({
				tenantId: 'tenant-b',
				cutoff: new Date(Date.now() - CALL_RETENTION_DAYS * DAY_MS),
				limit: 100,
			}),
		).toEqual({ removed: 1 });
		expect(await service.listCalls('tenant-b')).toEqual([]);
	});

	it('removes the idempotency keys claimed before the cutoff with the calls', async () => {
		const stale = Date.now() - 500 * DAY_MS;
		await shared.repository.claimCallKey('tenant-a', 'stale-key-0001', {
			operationId: 'instance-x:get',
			inputDigest: 'a'.repeat(64),
			claimedAt: stale,
			staleBefore: stale - 1,
		});
		const removed = await declaration('calls').sweep!({
			tenantId: 'tenant-a',
			cutoff: new Date(Date.now() - CALL_RETENTION_DAYS * DAY_MS),
			limit: 100,
		});
		expect(removed).toEqual({ removed: 1 });
		const again = await shared.repository.claimCallKey(
			'tenant-a',
			'stale-key-0001',
			{
				operationId: 'instance-y:post',
				inputDigest: 'b'.repeat(64),
				claimedAt: Date.now(),
				staleBefore: Date.now() - 1_000,
			},
		);
		expect(again).toEqual({ state: 'claimed' });
	});

	it('exports the call log of one workspace, paging past the page size', async () => {
		for (let index = 0; index < 5; index += 1) {
			await recordCall('tenant-a', 1_000 + index);
		}
		await recordCall('tenant-b', 2_000);

		const rows = await collect('calls', 'tenant-a');
		expect(rows).toHaveLength(5);
		expect(rows[0]).toMatchObject({
			tenantId: 'tenant-a',
			operation: 'get',
			outcome: 'succeeded',
			occurredAt: new Date(1_000).toISOString(),
		});
		expect(Object.keys(rows[0]!)).not.toContain('body');
	});

	it('exports instances without anything of the credential but its fingerprint', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
			credentials: { kind: 'bearer', token: 'bearer-token-0001' },
		});
		await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-b',
			baseUrl: testBaseUrl(server),
		});

		const rows = await collect('instances', 'tenant-a');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: instance.id,
			tenantId: 'tenant-a',
			authKind: 'bearer',
			credentialFingerprint: instance.credentialFingerprint,
			createdAt: new Date(1).toISOString(),
		});
		expect(Object.keys(rows[0]!)).not.toContain('credential');
		expect(JSON.stringify(rows)).not.toContain('bearer-token-0001');
	});

	it('exports the audit trail of one workspace', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
		});
		await instanceService(shared.repository, vault).consent(
			'tenant-a',
			'account-ada',
			instance.id,
			{ allowWorkflows: true, allowAgents: false, confirmed: true },
		);
		await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-b',
			baseUrl: testBaseUrl(server),
		});

		const rows = await collect('audit', 'tenant-a');
		expect(rows.map((row) => row.action)).toEqual([
			'instance.created',
			'instance.consent-changed',
		]);
		expect(rows[1]).toMatchObject({
			tenantId: 'tenant-a',
			instanceId: instance.id,
			actorId: 'account-ada',
		});
		expect(await collect('audit', 'tenant-b')).toHaveLength(1);
	});

	it('reports the range of what it exported', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
		});
		await callService(shared.repository, vault, testResolver()).call({
			tenantId: 'tenant-a',
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		const summary = await declaration('calls').export!({
			tenantId: 'tenant-a',
			sink: { write: async () => undefined },
		});
		expect(summary.rows).toBe(1);
		expect(summary.from).toBeInstanceOf(Date);
		expect(summary.to).toEqual(summary.from);
	});
});
