import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_JSON_DEFINITION } from '../src/domain/http-json.ts';
import type { CreateConnectorInstanceInput } from '../src/domain/types.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
	TEST_HOST,
	callService,
	instanceService,
	publicResolver,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testResolver,
	testVault,
	type TestServer,
} from './support/harness.ts';

const TENANT = 'tenant-egress';
const ACTOR = 'account-ada';

const BASE: CreateConnectorInstanceInput = {
	definitionKey: HTTP_JSON_DEFINITION.key,
	name: 'Egress',
	baseUrl: 'https://api.example.test/v1',
	authKind: 'none',
	credentials: {},
	allowedHosts: ['api.example.test'],
};

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

describe('CONNECTORS-EGRESS', () => {
	it('refuses a base URL that is not https to a public host, before any write', async () => {
		const service = instanceService(shared.repository, testVault());
		for (const baseUrl of [
			'http://api.example.test/v1',
			'https://localhost/v1',
			'https://127.0.0.1/v1',
			'https://[::1]/v1',
			'https://api.example.local/v1',
			'https://user:pass@api.example.test/v1',
			'not-a-url',
		]) {
			await expect(
				service.create(TENANT, ACTOR, { ...BASE, baseUrl }),
			).rejects.toMatchObject({ code: 'EGRESS_REFUSED' });
		}
		expect(await service.list(TENANT)).toEqual([]);
	});

	it('refuses a call whose host resolves into a blocked range, before any request leaves', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const before = server.requests.length;
		const calls = callService(
			shared.repository,
			vault,
			/* The name resolves into a private range, as a rebound host would. */
			publicResolver({ [TEST_HOST]: '10.1.2.3' }),
		);
		const result = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(result).toMatchObject({
			outcome: 'refused',
			errorClass: 'egress-refused',
			status: null,
		});
		expect(server.requests.length).toBe(before);
	});

	it('refuses a call to a host outside the instance allowlist', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
			allowedHosts: ['api.example.test'],
		});
		const before = server.requests.length;
		const result = await callService(
			shared.repository,
			vault,
			testResolver(),
		).call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(result).toMatchObject({
			outcome: 'refused',
			errorClass: 'egress-refused',
		});
		expect(server.requests.length).toBe(before);
	});

	it('records a name that no longer resolves as a failed call, not a refusal', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const result = await callService(shared.repository, vault, async () => {
			throw new Error('ENOTFOUND');
		}).call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(result).toMatchObject({ outcome: 'failed', errorClass: 'dns' });
	});

	it('keeps every refusal in the call log with its class and no body', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
			allowedHosts: ['api.example.test'],
		});
		await callService(shared.repository, vault, testResolver()).call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		const calls = await instanceService(shared.repository, vault).listCalls(
			TENANT,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			operation: 'get',
			caller: 'test',
			outcome: 'refused',
			errorClass: 'egress-refused',
			responseBytes: 0,
		});
		expect(Object.keys(calls[0] ?? {})).not.toContain('body');
	});
});
