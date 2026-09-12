import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

const LOOPBACK = testResolver();

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

describe('CONNECTORS-TENANT-BOUNDARY', () => {
	it('hides another workspace instance from every read and every change', async () => {
		const vault = testVault();
		const foreign = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
			name: 'Billing',
		});
		const service = instanceService(shared.repository, vault);

		expect(await service.list('tenant-b')).toEqual([]);
		await expect(
			service.disable('tenant-b', 'account-bob', foreign.id),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
		await expect(
			service.consent('tenant-b', 'account-bob', foreign.id, {
				allowWorkflows: true,
				allowAgents: true,
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
		await expect(
			service.remove('tenant-b', 'account-bob', foreign.id),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });

		/* The row is still there for its own workspace. */
		expect((await service.list('tenant-a')).map((row) => row.id)).toEqual([
			foreign.id,
		]);
	});

	it('refuses a call bound to the wrong workspace before it reaches the network', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
		});
		const before = server.requests.length;
		await expect(
			callService(shared.repository, vault, LOOPBACK).call({
				tenantId: 'tenant-b',
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				caller: 'test',
			}),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
		expect(server.requests.length).toBe(before);
	});

	it('keeps call rows and audit rows inside the workspace that produced them', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: 'tenant-a',
			baseUrl: testBaseUrl(server),
		});
		await callService(shared.repository, vault, LOOPBACK).call({
			tenantId: 'tenant-a',
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		const service = instanceService(shared.repository, vault);
		expect(await service.listCalls('tenant-a')).toHaveLength(1);
		expect(await service.listCalls('tenant-b')).toEqual([]);
		expect(await service.listAudit('tenant-a', instance.id)).toHaveLength(1);
		expect(await service.listAudit('tenant-b', instance.id)).toEqual([]);
	});

	/* The forced policy is the last line: a write that names another tenant is
	   rejected by the database even when the repository is asked to make it. */
	it('rejects a row carrying another tenant identifier under the forced policy', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO connectors_calls
						 (id, tenant_id, instance_id, operation, caller, outcome,
						  duration_ms, request_bytes, response_bytes, occurred_at)
						 VALUES ('call-x', 'tenant-b', 'instance-x', 'get', 'test',
						         'succeeded', 1, 0, 0, 1)`,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();
	});
});
