import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { CALL_KEY_CLAIM_MS } from '../src/services/call-service.ts';
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
	testConnect,
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
		allowWorkflows: true,
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
	it.each(['agent', 'workflow'] as const)(
		'refuses an unkeyed %s call before provider egress',
		async (caller) => {
			const { instance, calls } = await fixture();
			const before = server.requests.length;
			const result = await calls.call({
				...request(instance.id),
				caller,
				idempotencyKey: undefined,
			});
			expect(result).toMatchObject({
				outcome: 'refused',
				errorClass: 'idempotency-key-required',
			});
			expect(server.requests).toHaveLength(before);
		},
	);

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
			await instanceService(shared.repository, vault).listCalls(
				TENANT,
				{},
				{ limit: 200 },
			),
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
			instanceId: instance.id,
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

	it('refuses a later attempt under a stale claim with no recorded outcome', async () => {
		const { instance, calls } = await fixture();
		const stale = Date.now() - CALL_KEY_CLAIM_MS - 1_000;
		await shared.repository.claimCallKey(TENANT, KEY, {
			instanceId: instance.id,
			operationId: `${instance.id}:get`,
			inputDigest: await digestOf(instance.id, calls),
			claimedAt: stale,
			staleBefore: stale - CALL_KEY_CLAIM_MS,
		});
		const before = server.requests.length;
		await expect(calls.call(request(instance.id))).rejects.toMatchObject({
			code: 'CALL_OUTCOME_UNKNOWN',
		});
		await expect(
			calls.call({ ...request(instance.id), input: { path: '/different' } }),
		).rejects.toMatchObject({ code: 'CALL_IDEMPOTENCY_CONFLICT' });
		expect(server.requests.length).toBe(before);
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

describe('CONNECTORS-CRASH-BEFORE-LOG', () => {
	it('keeps a stale unbound claim unknown after the provider acted and recordCall crashed', async () => {
		const { instance, calls, vault } = await fixture();
		const before = server.requests.length;
		const crash = vi
			.spyOn(shared.repository, 'recordCall')
			.mockRejectedValue(new Error('simulated crash before call record'));
		const firstCallStartedAt = Date.now();
		try {
			await expect(calls.call(request(instance.id))).rejects.toMatchObject({
				code: 'CALL_OUTCOME_UNKNOWN',
			});
		} finally {
			crash.mockRestore();
		}
		const firstCallFinishedAt = Date.now();
		expect(server.requests.length).toBe(before + 1);
		const immediateAudit = (
			await shared.repository.listAudit(TENANT, instance.id, 10)
		).filter((entry) => entry.action === 'call.outcome-unknown');
		expect(immediateAudit).toHaveLength(1);
		const [initialEvent] = immediateAudit;
		expect(initialEvent?.metadata.claimedAt).toBeGreaterThanOrEqual(
			firstCallStartedAt,
		);
		expect(initialEvent?.metadata.claimedAt).toBeLessThanOrEqual(
			firstCallFinishedAt,
		);
		expect(initialEvent?.metadata.observedAt).toBeGreaterThanOrEqual(
			firstCallStartedAt,
		);
		expect(initialEvent?.metadata.observedAt).toBeLessThanOrEqual(
			firstCallFinishedAt,
		);
		expect(initialEvent?.occurredAt).toBe(initialEvent?.metadata.observedAt);
		expect(
			await instanceService(shared.repository, vault).listCalls(
				TENANT,
				{},
				{ limit: 200 },
			),
		).toHaveLength(0);

		const stale = Date.now() - CALL_KEY_CLAIM_MS - 1_000;
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE connectors_call_keys SET claimed_at = $3
					 WHERE tenant_id = $1 AND idempotency_key = $2`,
					parameters: [TENANT, KEY, stale],
				}),
			{ access: 'write', tenantId: TENANT },
		);
		const refusalStartedAt = Date.now();
		await expect(calls.call(request(instance.id))).rejects.toMatchObject({
			code: 'CALL_OUTCOME_UNKNOWN',
		});
		await expect(calls.call(request(instance.id))).rejects.toMatchObject({
			code: 'CALL_OUTCOME_UNKNOWN',
		});
		const refusalFinishedAt = Date.now();
		expect(server.requests.length).toBe(before + 1);
		const audit = (
			await shared.repository.listAudit(TENANT, instance.id, 10)
		).filter((entry) => entry.action === 'call.outcome-unknown');
		expect(audit).toHaveLength(3);
		for (const event of audit.filter(
			(entry) => entry.id !== initialEvent?.id,
		)) {
			expect(Object.keys(event.metadata).sort()).toEqual([
				'claimedAt',
				'keyDigest',
				'observedAt',
				'operationId',
			]);
			expect(event.metadata).toMatchObject({
				operationId: `${instance.id}:get`,
				keyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				claimedAt: stale,
			});
			expect(event.metadata.observedAt).toBeGreaterThanOrEqual(
				refusalStartedAt,
			);
			expect(event.metadata.observedAt).toBeLessThanOrEqual(refusalFinishedAt);
			expect(event.occurredAt).toBe(event.metadata.observedAt);
			expect(JSON.stringify(event)).not.toContain(KEY);
			expect(JSON.stringify(event)).not.toContain('/things');
		}
		expect(JSON.stringify(audit)).not.toContain(KEY);
		expect(JSON.stringify(audit)).not.toContain('/things');
		expect(
			await shared.repository.listAudit('tenant-other', instance.id, 10),
		).toEqual([]);
	});

	it('keeps the claim unknown when both call recording and best-effort audit fail', async () => {
		const { instance, calls } = await fixture();
		const before = server.requests.length;
		const recordFailure = vi
			.spyOn(shared.repository, 'recordCall')
			.mockRejectedValue(new Error('provider-secret-from-record-error'));
		const auditFailure = vi
			.spyOn(shared.repository, 'auditUnknownCall')
			.mockRejectedValue(new Error('provider-secret-from-audit-error'));
		let failure: unknown;
		try {
			failure = await calls.call(request(instance.id)).then(
				() => null,
				(error: unknown) => error,
			);
			expect(auditFailure).toHaveBeenCalledTimes(1);
		} finally {
			recordFailure.mockRestore();
			auditFailure.mockRestore();
		}
		expect(failure).toMatchObject({ code: 'CALL_OUTCOME_UNKNOWN' });
		expect(String(failure)).not.toContain('provider-secret');
		expect(server.requests.length).toBe(before + 1);
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE connectors_call_keys SET claimed_at = $3
					 WHERE tenant_id = $1 AND idempotency_key = $2`,
					parameters: [TENANT, KEY, Date.now() - CALL_KEY_CLAIM_MS - 1_000],
				}),
			{ access: 'write', tenantId: TENANT },
		);
		await expect(calls.call(request(instance.id))).rejects.toMatchObject({
			code: 'CALL_OUTCOME_UNKNOWN',
		});
		expect(server.requests.length).toBe(before + 1);
	});
});

describe('CONNECTORS-KEY-BINDING', () => {
	it('releases the key after TLS when no HTTP write was attempted', async () => {
		const { instance, vault } = await fixture();
		const controller = new AbortController();
		let beforeWrites = 0;
		const calls = callService(
			shared.repository,
			vault,
			testResolver(),
			TEST_LIMITS,
			{
				...testConnect(),
				beforeRequestWrite: () => {
					beforeWrites += 1;
					if (beforeWrites === 1) controller.abort();
				},
			},
		);
		const before = server.requests.length;
		const first = await calls.call({
			...request(instance.id),
			signal: controller.signal,
		});
		expect(first).toMatchObject({
			outcome: 'failed',
			errorClass: 'timeout',
			replayed: false,
		});
		expect(server.requests.length).toBe(before);
		const retry = await calls.call(request(instance.id));
		expect(retry).toMatchObject({ outcome: 'succeeded', replayed: false });
		expect(retry.callId).not.toBe(first.callId);
		expect(server.requests.length).toBe(before + 1);
		expect(beforeWrites).toBe(2);
	});

	it('keeps the key when a body write fails before request finish', async () => {
		const { instance, vault } = await fixture();
		const controller = new AbortController();
		let bodyWrites = 0;
		const calls = callService(
			shared.repository,
			vault,
			testResolver(),
			TEST_LIMITS,
			{
				...testConnect(),
				afterBodyWrite: (requestFinished) => {
					expect(requestFinished).toBe(false);
					bodyWrites += 1;
					controller.abort();
				},
			},
		);
		const input = {
			...request(instance.id),
			operation: 'post' as const,
			input: { path: '/things', body: { value: 'sample' } },
		};
		const first = await calls.call({
			...input,
			signal: controller.signal,
		});
		expect(first).toMatchObject({
			outcome: 'failed',
			errorClass: 'timeout',
			replayed: false,
		});
		expect(bodyWrites).toBe(1);
		const replay = await calls.call(input);
		expect(replay).toMatchObject({
			callId: first.callId,
			outcome: 'failed',
			replayed: true,
		});
		expect(bodyWrites).toBe(1);
	});

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

	/* A failure observed before the request was written left the external
	   system untouched, so its claim is released for an immediate retry. */
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
		const later = Date.now();
		expect(
			await shared.repository.claimCallKey(TENANT, KEY, {
				instanceId: instance.id,
				operationId: `${instance.id}:get`,
				inputDigest: 'a'.repeat(64),
				claimedAt: later,
				staleBefore: later - CALL_KEY_CLAIM_MS,
			}),
		).toEqual({ state: 'claimed' });
	});
});

describe('CONNECTORS-KEY-UNKNOWN-RACE', () => {
	const TENANT_RACE = 'tenant-race';
	const RACE_KEY = 'workflow-run-9:node-1';

	function claimOn(claimedAt: number, staleBefore: number) {
		return shared.repository.claimCallKey(TENANT_RACE, RACE_KEY, {
			instanceId: 'instance-9',
			operationId: 'instance-9:get',
			inputDigest: 'a'.repeat(64),
			claimedAt,
			staleBefore,
		});
	}

	it('refuses both retries without changing the old claim', async () => {
		const abandoned = 1_000;
		expect(await claimOn(abandoned, 0)).toEqual({
			state: 'claimed',
		});
		const now = abandoned + CALL_KEY_CLAIM_MS + 1_000;
		const answers = await Promise.all([
			claimOn(now, now - CALL_KEY_CLAIM_MS),
			claimOn(now + 1, now - CALL_KEY_CLAIM_MS),
		]);
		expect(answers).toEqual([{ state: 'unknown' }, { state: 'unknown' }]);
		const row = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ claimed_at: number | bigint | string }>({
					text: `SELECT claimed_at FROM connectors_call_keys
					 WHERE tenant_id = $1 AND idempotency_key = $2`,
					parameters: [TENANT_RACE, RACE_KEY],
				}),
			{ access: 'read', tenantId: TENANT_RACE },
		);
		expect(Number(row.rows[0]?.claimed_at)).toBe(abandoned);
		const audit = await shared.repository.listAudit(
			TENANT_RACE,
			'instance-9',
			10,
		);
		expect(audit).toHaveLength(2);
		expect(
			audit.every((entry) => entry.action === 'call.outcome-unknown'),
		).toBe(true);
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
			instanceId,
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
