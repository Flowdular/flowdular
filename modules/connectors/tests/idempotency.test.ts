import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CALL_KEY_CLAIM_MS } from '../src/services/call-service.ts';
import { DatabaseConnectorsRepository } from '../src/services/database-repository.ts';
import { createInterleavedCallKeyDatabase } from './support/interleaved-database.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
	TEST_HOST,
	TEST_LIMITS,
	callService,
	instanceService,
	seedInstance,
	startTestServer,
	testBaseUrl,
	testResolver,
	testVault,
	type TestServer,
} from './support/harness.ts';

const TENANT = 'tenant-idempotency';
const KEY = 'workflow-run-1:node-1';

let shared: ConnectorsTestDatabase;
let server: TestServer;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	server = await startTestServer((request) => ({
		body: JSON.stringify({ ok: true, url: request.url }),
	}));
});

afterAll(async () => {
	await server?.close();
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function fixture(tenantId = TENANT) {
	const vault = testVault();
	const instance = await seedInstance(shared.repository, vault, {
		tenantId,
		baseUrl: testBaseUrl(server),
		allowAgents: true,
	});
	return {
		instance,
		vault,
		calls: callService(shared.repository, vault, testResolver()),
	};
}

function request(instanceId: string, idempotencyKey = KEY) {
	return {
		tenantId: TENANT,
		instanceId,
		operation: 'get' as const,
		input: { path: '/things' },
		caller: 'agent' as const,
		idempotencyKey,
	};
}

describe('connector call idempotency ledger', () => {
	it('answers the first call on a repeat instead of reaching the system again', async () => {
		const { instance, calls, vault } = await fixture();
		const before = server.requests.length;
		const first = await calls.call(request(instance.id));
		expect(first).toMatchObject({
			outcome: 'succeeded',
			status: 200,
			replayed: false,
		});

		const second = await calls.call(request(instance.id));
		expect(second).toMatchObject({
			callId: first.callId,
			outcome: 'succeeded',
			status: 200,
			replayed: true,
		});
		/* A replay carries no body: the log never kept one. */
		expect(second.body).toBeNull();
		expect(server.requests.length).toBe(before + 1);
		expect(
			await instanceService(shared.repository, vault).listCalls(TENANT),
		).toHaveLength(1);
	});

	/* A write whose answer was lost must not be retried under the same key. */
	it('replays a recorded failure rather than repeating the request', async () => {
		const failing = await startTestServer(() => ({
			status: 500,
			body: '{"error":"down"}',
		}));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(failing),
				allowAgents: true,
			});
			const calls = callService(shared.repository, vault, testResolver());
			const first = await calls.call(request(instance.id));
			expect(first).toMatchObject({ outcome: 'failed', status: 500 });
			const before = failing.requests.length;
			expect(await calls.call(request(instance.id))).toMatchObject({
				callId: first.callId,
				outcome: 'failed',
				replayed: true,
			});
			expect(failing.requests.length).toBe(before);
		} finally {
			await failing.close();
		}
	});

	it('refuses the same key for another operation or another input', async () => {
		const { instance, calls } = await fixture();
		await calls.call(request(instance.id));
		await expect(
			calls.call({ ...request(instance.id), operation: 'delete' }),
		).rejects.toMatchObject({
			code: 'CALL_IDEMPOTENCY_CONFLICT',
			status: 409,
		});
		await expect(
			calls.call({ ...request(instance.id), input: { path: '/other' } }),
		).rejects.toMatchObject({ code: 'CALL_IDEMPOTENCY_CONFLICT' });
	});

	it('refuses a second attempt while the first still holds the claim', async () => {
		const { instance, calls } = await fixture();
		const now = Date.now();
		const claim = await shared.repository.claimCallKey(TENANT, KEY, {
			operationId: `${instance.id}:get`,
			inputDigest: 'x'.repeat(64),
			claimedAt: now,
			staleBefore: now - CALL_KEY_CLAIM_MS,
		});
		expect(claim).toEqual({ state: 'claimed' });
		const before = server.requests.length;
		await expect(calls.call(request(instance.id))).rejects.toMatchObject({
			code: 'CALL_IDEMPOTENCY_CONFLICT',
		});
		expect(server.requests.length).toBe(before);
	});

	it('lets a later attempt take over a claim nothing finished', async () => {
		const { instance, calls } = await fixture();
		const stale = Date.now() - CALL_KEY_CLAIM_MS - 1_000;
		await shared.repository.claimCallKey(TENANT, KEY, {
			operationId: `${instance.id}:get`,
			inputDigest: await digestOf(instance.id, calls),
			claimedAt: stale,
			staleBefore: stale - CALL_KEY_CLAIM_MS,
		});
		const before = server.requests.length;
		expect(await calls.call(request(instance.id))).toMatchObject({
			outcome: 'succeeded',
			replayed: false,
		});
		expect(server.requests.length).toBe(before + 1);
	});

	it('keeps one key per workspace', async () => {
		const first = await fixture();
		const other = await fixture('tenant-other');
		await first.calls.call(request(first.instance.id));
		const elsewhere = await other.calls.call({
			...request(other.instance.id),
			tenantId: 'tenant-other',
		});
		expect(elsewhere).toMatchObject({ outcome: 'succeeded', replayed: false });
	});
});

describe('CONNECTORS-KEY-BINDING', () => {
	/* The token exchange is an outbound call of its own, and one that fails has
	   told the external system nothing. A key bound to it would answer every
	   later attempt with a call that never happened, for as long as the log
	   keeps the row. */
	it('leaves the key free when the token exchange is refused', async () => {
		let refusals = 0;
		const external = await startTestServer((incoming) => {
			if (!incoming.url.startsWith('/token')) {
				return { body: JSON.stringify({ ok: true }) };
			}
			refusals += 1;
			return refusals === 1
				? { status: 500, body: '{"error":"token endpoint down"}' }
				: {
						body: JSON.stringify({
							access_token: 'token-0002',
							expires_in: 300,
						}),
					};
		});
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(external),
				allowAgents: true,
				credentials: {
					kind: 'oauth2-client-credentials',
					tokenUrl: `${testBaseUrl(external)}/token`,
					clientId: 'client-0001',
					clientSecret: 'client-secret-0001',
					scope: null,
				},
			});
			const calls = callService(shared.repository, vault, testResolver());
			expect(await calls.call(request(instance.id))).toMatchObject({
				outcome: 'failed',
				errorClass: 'credential-unavailable',
			});
			expect(await calls.call(request(instance.id))).toMatchObject({
				outcome: 'succeeded',
				status: 200,
				replayed: false,
			});
			expect(external.requests.at(-1)!.headers.authorization).toBe(
				'Bearer token-0002',
			);
		} finally {
			await external.close();
		}
	});

	/* The other side of the same boundary. A write whose answer was lost is not a
	   write that never happened, so a call the external system already read keeps
	   its key however it ended. */
	it('keeps the key bound to a call that timed out after the request went out', async () => {
		const stalling = await startTestServer(() => ({ stall: true }));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(stalling),
				allowAgents: true,
			});
			const calls = callService(shared.repository, vault, testResolver(), {
				timeoutMs: 1_000,
				maxResponseBytes: TEST_LIMITS.maxResponseBytes,
			});
			const first = await calls.call(request(instance.id));
			expect(first).toMatchObject({ outcome: 'failed', errorClass: 'timeout' });
			const sent = stalling.requests.length;
			expect(await calls.call(request(instance.id))).toMatchObject({
				callId: first.callId,
				outcome: 'failed',
				errorClass: 'timeout',
				replayed: true,
			});
			expect(stalling.requests.length).toBe(sent);
		} finally {
			await stalling.close();
		}
	});

	/* A failure raised before the request was written left the external system
	   untouched, so the key must not be bound to it: once the claim goes stale a
	   later attempt takes it over rather than replaying a call that never
	   happened. */
	it('binds no key to a call that never reached the network', async () => {
		const vanished = await startTestServer(() => ({ body: '{}' }));
		await vanished.close();
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: `https://${TEST_HOST}:${vanished.port}`,
			allowAgents: true,
		});
		const calls = callService(shared.repository, vault, testResolver());
		expect(await calls.call(request(instance.id))).toMatchObject({
			outcome: 'failed',
			errorClass: 'network',
		});
		const later = Date.now() + CALL_KEY_CLAIM_MS + 1_000;
		expect(
			await shared.repository.claimCallKey(TENANT, KEY, {
				operationId: `${instance.id}:get`,
				inputDigest: await digestOf(instance.id, calls),
				claimedAt: later,
				staleBefore: later - CALL_KEY_CLAIM_MS,
			}),
		).toEqual({ state: 'claimed' });
	});
});

/* Two attempts that read the same abandoned claim overlap only when the engine
   really runs them at once, which the embedded PostgreSQL of this suite never
   does: it queues transactions on one connection, so the second reads the claim
   time the first already committed and is answered in flight either way. The
   interleaved handle runs both concurrently instead. */
describe('CONNECTORS-KEY-RETAKE-RACE', () => {
	const TENANT_RACE = 'tenant-race';
	const RACE_KEY = 'workflow-run-9:node-1';

	function claimOn(
		repository: DatabaseConnectorsRepository,
		claimedAt: number,
		staleBefore: number,
	) {
		return repository.claimCallKey(TENANT_RACE, RACE_KEY, {
			operationId: 'instance-9:get',
			inputDigest: 'a'.repeat(64),
			claimedAt,
			staleBefore,
		});
	}

	it('hands the key to exactly one of them', async () => {
		const interleaved = createInterleavedCallKeyDatabase();
		const repository = new DatabaseConnectorsRepository(interleaved.handle);
		const abandoned = 1_000;
		expect(await claimOn(repository, abandoned, 0)).toEqual({
			state: 'claimed',
		});
		const now = abandoned + CALL_KEY_CLAIM_MS + 1_000;
		const answers = await Promise.all([
			claimOn(repository, now, now - CALL_KEY_CLAIM_MS),
			claimOn(repository, now + 1, now - CALL_KEY_CLAIM_MS),
		]);
		expect(answers.filter((answer) => answer.state === 'claimed')).toHaveLength(
			1,
		);
		expect(
			answers.filter((answer) => answer.state === 'in-flight'),
		).toHaveLength(1);
		/* The insert, then one retake: the attempt that lost the row wrote
		   nothing, so the winner's claim time is still the one in the ledger. */
		expect(interleaved.retakes).toEqual([now]);
	});
});

/* The digest the service computes for this input, obtained by letting it write
   one claim and reading it back, so the test never restates the algorithm. */
async function digestOf(
	instanceId: string,
	calls: ReturnType<typeof callService>,
): Promise<string> {
	await calls.call(request(instanceId, 'digest-probe-key'));
	const probe = await shared.repository.claimCallKey(
		TENANT,
		'digest-probe-key',
		{
			operationId: `${instanceId}:get`,
			inputDigest: 'unused',
			claimedAt: 0,
			staleBefore: 0,
		},
	);
	if (probe.state !== 'conflict') {
		throw new Error('The probe key should already be bound.');
	}
	const rows = await shared.runtime.transaction(
		(transaction) =>
			transaction.query<{ input_digest: string }>({
				text: `SELECT input_digest FROM connectors_call_keys
				 WHERE tenant_id = $1 AND idempotency_key = $2`,
				parameters: [TENANT, 'digest-probe-key'],
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return rows.rows[0]!.input_digest;
}
