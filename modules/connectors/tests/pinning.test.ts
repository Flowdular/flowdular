import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createConnectorEgressPolicy,
	pinnedLookup,
	type HostAddressResolver,
} from '../src/services/egress.ts';
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
	testConnect,
	testVault,
	TEST_HOST,
	TEST_LIMITS,
	TEST_PUBLIC_ADDRESS,
	type TestServer,
} from './support/harness.ts';

const TENANT = 'tenant-pinning';

/**
 * The rebinding answer: public while the policy asks, private from the moment
 * the connection would have asked again. Anything that resolves the name a
 * second time reaches the private address.
 */
function rebindingResolver(): {
	readonly resolve: HostAddressResolver;
	readonly calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		resolve: async () => {
			calls += 1;
			return calls === 1
				? [{ address: TEST_PUBLIC_ADDRESS }]
				: [{ address: '10.1.2.3' }];
		},
	};
}

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

describe('pinned egress', () => {
	it('answers only the addresses the policy accepted, without asking again', async () => {
		const rebinding = rebindingResolver();
		const policy = createConnectorEgressPolicy({
			allowlist: new Set([TEST_HOST]),
			resolve: rebinding.resolve,
		});
		const accepted = await policy.assertResolvable(TEST_HOST);
		expect(accepted.map((entry) => entry.address)).toEqual([
			TEST_PUBLIC_ADDRESS,
		]);

		const lookup = pinnedLookup(TEST_HOST, accepted);
		const all = await new Promise<unknown>((resolve, reject) =>
			lookup(TEST_HOST, { all: true }, (error, address) =>
				error ? reject(error) : resolve(address),
			),
		);
		expect(all).toEqual([{ address: TEST_PUBLIC_ADDRESS, family: 4 }]);
		const single = await new Promise<unknown>((resolve, reject) =>
			lookup(TEST_HOST, {}, (error, address) =>
				error ? reject(error) : resolve(address),
			),
		);
		expect(single).toBe(TEST_PUBLIC_ADDRESS);
		/* The policy asked once; the lookup never goes back to the resolver. */
		expect(rebinding.calls()).toBe(1);
	});

	it('refuses to answer for a host it was not pinned to', async () => {
		const lookup = pinnedLookup(TEST_HOST, [{ address: TEST_PUBLIC_ADDRESS }]);
		await expect(
			new Promise((resolve, reject) =>
				lookup('other.example.test', { all: true }, (error, address) =>
					error ? reject(error) : resolve(address),
				),
			),
		).rejects.toThrow(/No verified address is pinned/);
	});

	/* Before the connection was pinned, undici resolved the host itself after
	   the check had passed, so the second answer was the one it connected to. */
	it('dials only the verified address when the name rebinds after the check', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const rebinding = rebindingResolver();
		const dialled: string[] = [];
		const result = await callService(
			shared.repository,
			vault,
			rebinding.resolve,
			TEST_LIMITS,
			testConnect(dialled),
		).call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});

		expect(result).toMatchObject({ outcome: 'succeeded', status: 200 });
		expect(dialled).toEqual([TEST_PUBLIC_ADDRESS]);
		expect(rebinding.calls()).toBe(1);
		expect(server.requests.at(-1)!.headers.host).toBe(
			`${TEST_HOST}:${server.port}`,
		);
	});

	it('refuses a call whose target is not https before anything leaves', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: `http://${TEST_HOST}:${server.port}`,
		});
		const before = server.requests.length;
		const dialled: string[] = [];
		const result = await callService(
			shared.repository,
			vault,
			rebindingResolver().resolve,
			TEST_LIMITS,
			testConnect(dialled),
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
			status: null,
		});
		expect(dialled).toEqual([]);
		expect(server.requests.length).toBe(before);
		/* The refusal is in the log with its class, like every other one. */
		expect(
			(await instanceService(shared.repository, vault).listCalls(TENANT))[0],
		).toMatchObject({ outcome: 'refused', errorClass: 'egress-refused' });
	});
});
