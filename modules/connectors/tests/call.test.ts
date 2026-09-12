import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import {
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

const TENANT = 'tenant-call';
const LOOPBACK = testResolver();

let shared: ConnectorsTestDatabase;
let server: TestServer;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	server = await startTestServer((request) => {
		if (request.url.startsWith('/token')) {
			return {
				body: JSON.stringify({ access_token: 'token-0001', expires_in: 300 }),
			};
		}
		if (request.url.startsWith('/missing')) {
			return { status: 404, body: '{"error":"absent"}' };
		}
		if (request.url.startsWith('/broken')) {
			return { status: 503, body: '{"error":"down"}' };
		}
		if (request.url.startsWith('/moved')) {
			return {
				status: 302,
				body: '',
				headers: { location: 'https://elsewhere.example.test/' },
			};
		}
		if (request.url.startsWith('/huge')) {
			return { body: JSON.stringify({ blob: 'x'.repeat(128 * 1_024) }) };
		}
		if (request.url.startsWith('/text')) {
			return { body: 'plain text', contentType: 'text/plain' };
		}
		return { body: JSON.stringify({ ok: true, url: request.url }) };
	});
});

afterAll(async () => {
	await server?.close();
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

async function fixture(options: Parameters<typeof seedInstance>[2]) {
	const vault = testVault();
	const instance = await seedInstance(shared.repository, vault, options);
	return {
		instance,
		calls: callService(shared.repository, vault, LOOPBACK),
		vault,
	};
}

function base(): string {
	return testBaseUrl(server);
}

describe('CONNECTORS-TEST-CALL', () => {
	it('sends no credential for the none authentication kind', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const result = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things', query: { page: 2 } },
			caller: 'test',
		});
		const sent = server.requests.at(-1)!;
		expect(result).toMatchObject({ outcome: 'succeeded', status: 200 });
		expect(result.body).toMatchObject({ ok: true });
		expect(sent.url).toBe('/things?page=2');
		expect(sent.headers.authorization).toBeUndefined();
		expect(sent.headers['x-api-key']).toBeUndefined();
	});

	it('sends the api key in the header the credential names', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
			credentials: {
				kind: 'api-key',
				header: 'x-api-key',
				value: 'secret-value-0001',
			},
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(server.requests.at(-1)!.headers['x-api-key']).toBe(
			'secret-value-0001',
		);
	});

	it('sends a bearer token as the authorization header', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
			credentials: { kind: 'bearer', token: 'bearer-token-0001' },
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'post',
			input: { path: '/things', body: { name: 'Acme' } },
			caller: 'test',
		});
		const sent = server.requests.at(-1)!;
		expect(sent.headers.authorization).toBe('Bearer bearer-token-0001');
		expect(sent.method).toBe('POST');
		expect(sent.body).toBe('{"name":"Acme"}');
		/* An explicit length, not a chunked body: some external systems refuse
		   chunked requests. */
		expect(sent.headers['content-length']).toBe('15');
		expect(sent.headers['transfer-encoding']).toBeUndefined();
	});

	it('exchanges client credentials once and reuses the cached token', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
			credentials: {
				kind: 'oauth2-client-credentials',
				tokenUrl: `${base()}/token`,
				clientId: 'client-0001',
				clientSecret: 'client-secret-0001',
				scope: 'read',
			},
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		const tokenRequests = server.requests.filter((request) =>
			request.url.startsWith('/token'),
		);
		expect(tokenRequests).toHaveLength(1);
		expect(tokenRequests[0]!.headers.authorization).toBe(
			'Basic ' +
				Buffer.from('client-0001:client-secret-0001').toString('base64'),
		);
		expect(tokenRequests[0]!.body).toContain('grant_type=client_credentials');
		expect(tokenRequests[0]!.body).toContain('scope=read');
		expect(server.requests.at(-1)!.headers.authorization).toBe(
			'Bearer token-0001',
		);
	});

	it('drops a cached token when the instance changes', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: base(),
			credentials: {
				kind: 'oauth2-client-credentials',
				tokenUrl: `${base()}/token`,
				clientId: 'client-0001',
				clientSecret: 'client-secret-0001',
				scope: null,
			},
		});
		const calls = callService(shared.repository, vault, LOOPBACK);
		const service = instanceService(shared.repository, vault, (tenant, id) =>
			calls.forget(tenant, id),
		);
		const invoke = () =>
			calls.call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				caller: 'test',
			});
		const tokenRequests = () =>
			server.requests.filter((request) => request.url.startsWith('/token'))
				.length;
		const before = tokenRequests();
		await invoke();
		await service.disable(TENANT, 'account-ada', instance.id);
		await service.enable(TENANT, 'account-ada', instance.id);
		await invoke();
		expect(tokenRequests() - before).toBe(2);
	});

	it('classifies a 404 and a 503 as failed calls that still carry a body', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const missing = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/missing' },
			caller: 'test',
		});
		expect(missing).toMatchObject({
			outcome: 'failed',
			status: 404,
			errorClass: 'response-4xx',
		});
		expect(missing.body).toEqual({ error: 'absent' });

		const broken = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/broken' },
			caller: 'test',
		});
		expect(broken).toMatchObject({
			outcome: 'failed',
			status: 503,
			errorClass: 'response-5xx',
		});
	});

	it('never follows a redirect', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const result = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/moved' },
			caller: 'test',
		});
		expect(result).toMatchObject({
			outcome: 'failed',
			status: 302,
			errorClass: 'egress-refused',
		});
	});

	it('refuses a response past the size cap', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const result = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/huge' },
			caller: 'test',
		});
		expect(result).toMatchObject({
			outcome: 'failed',
			errorClass: 'response-too-large',
			body: null,
			bodyPreview: '',
		});
		expect(result.responseBytes).toBeGreaterThan(TEST_LIMITS.maxResponseBytes);
	});

	it('aborts a stalled response on the timeout', async () => {
		const stalling = await startTestServer(() => ({ stall: true }));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(stalling),
			});
			const result = await callService(shared.repository, vault, LOOPBACK, {
				timeoutMs: 1_000,
				maxResponseBytes: 1_024,
			}).call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/slow' },
				caller: 'test',
			});
			expect(result).toMatchObject({
				outcome: 'failed',
				errorClass: 'timeout',
			});
		} finally {
			await stalling.close();
		}
	});

	/* Headers and a first chunk, then silence: the deadline has to cover the
	   body, not only the time to the first byte. */
	it('aborts a response that stalls after its first chunk', async () => {
		const stalling = await startTestServer(() => ({
			chunks: ['{"blob":"'],
			stall: true,
		}));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(stalling),
			});
			const started = Date.now();
			const result = await callService(shared.repository, vault, LOOPBACK, {
				timeoutMs: 1_000,
				maxResponseBytes: 64 * 1_024,
			}).call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/slow-body' },
				caller: 'test',
			});
			expect(result).toMatchObject({
				outcome: 'failed',
				errorClass: 'timeout',
			});
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			await stalling.close();
		}
	});

	it('refuses a streamed response the moment it passes the cap', async () => {
		const streaming = await startTestServer(() => ({
			chunks: ['x'.repeat(2_048), 'x'.repeat(2_048), 'x'.repeat(2_048)],
		}));
		try {
			const vault = testVault();
			const instance = await seedInstance(shared.repository, vault, {
				tenantId: TENANT,
				baseUrl: testBaseUrl(streaming),
			});
			const result = await callService(shared.repository, vault, LOOPBACK, {
				timeoutMs: 2_000,
				maxResponseBytes: 3_000,
			}).call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/stream' },
				caller: 'test',
			});
			expect(result).toMatchObject({
				outcome: 'failed',
				errorClass: 'response-too-large',
				body: null,
				bodyPreview: '',
			});
			expect(result.responseBytes).toBeGreaterThan(3_000);
			/* It stopped at the chunk that crossed the cap, not at the whole body. */
			expect(result.responseBytes).toBeLessThan(3 * 2_048);
		} finally {
			await streaming.close();
		}
	});

	/* A token obtained under the previous client secret must never be sent with
	   the new one, whatever the invalidation hook did. */
	it('keeps a cached token out of reach of a replaced credential', async () => {
		const vault = testVault();
		const credentials = {
			kind: 'oauth2-client-credentials',
			tokenUrl: `${base()}/token`,
			clientId: 'client-0001',
			clientSecret: 'client-secret-0001',
			scope: null,
		} as const;
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: base(),
			credentials,
		});
		const calls = callService(shared.repository, vault, LOOPBACK);
		const invoke = () =>
			calls.call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				caller: 'test',
			});
		const tokenRequests = () =>
			server.requests.filter((request) => request.url.startsWith('/token'))
				.length;

		const before = tokenRequests();
		await invoke();
		expect(tokenRequests() - before).toBe(1);
		await invoke();
		expect(tokenRequests() - before).toBe(1);

		/* The stored credential is replaced without the cache being told. */
		const replaced = await instanceService(shared.repository, vault).update(
			TENANT,
			'account-ada',
			instance.id,
			{
				name: instance.name,
				baseUrl: instance.baseUrl,
				allowedHosts: [...instance.allowedHosts],
				credentials: {
					tokenUrl: credentials.tokenUrl,
					clientId: 'client-0002',
					clientSecret: 'client-secret-0002',
				},
			},
		);
		expect(replaced.credentialFingerprint).not.toBe(
			instance.credentialFingerprint,
		);
		await invoke();
		expect(tokenRequests() - before).toBe(2);
	});

	it('drops the cached token when the credential is replaced or the instance is deleted', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: base(),
			credentials: {
				kind: 'oauth2-client-credentials',
				tokenUrl: `${base()}/token`,
				clientId: 'client-0001',
				clientSecret: 'client-secret-0001',
				scope: null,
			},
		});
		const forgotten: string[] = [];
		const calls = callService(shared.repository, vault, LOOPBACK);
		const service = instanceService(shared.repository, vault, (tenant, id) => {
			forgotten.push(`${tenant}:${id}`);
			calls.forget(tenant, id);
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});

		await service.update(TENANT, 'account-ada', instance.id, {
			name: instance.name,
			baseUrl: instance.baseUrl,
			allowedHosts: [...instance.allowedHosts],
			credentials: {
				tokenUrl: `${base()}/token`,
				clientId: 'client-0002',
				clientSecret: 'client-secret-0002',
			},
		});
		await service.disable(TENANT, 'account-ada', instance.id);
		await service.remove(TENANT, 'account-ada', instance.id);
		expect(forgotten).toEqual([
			`${TENANT}:${instance.id}`,
			`${TENANT}:${instance.id}`,
			`${TENANT}:${instance.id}`,
		]);
		/* Nothing of the deleted instance is left behind to answer a later call. */
		await expect(
			calls.call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				caller: 'test',
			}),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' });
	});

	it('hands a non-JSON body back as a preview and no parsed body', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const result = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/text' },
			caller: 'test',
		});
		expect(result.body).toBeNull();
		expect(result.bodyPreview).toBe('plain text');
	});

	it('refuses an operation the definition does not declare and an input it cannot expand', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: base(),
		});
		const unknown = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'head',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(unknown).toMatchObject({
			outcome: 'refused',
			errorClass: 'operation-unknown',
		});
		for (const input of [{}, { path: 'things' }, { path: '/a?b=1' }]) {
			const refused = await calls.call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input,
				caller: 'test',
			});
			expect(refused).toMatchObject({
				outcome: 'refused',
				errorClass: 'invalid-input',
			});
		}
	});

	it('keeps a path value inside the base path of the instance', async () => {
		const { instance, calls } = await fixture({
			tenantId: TENANT,
			baseUrl: `${base()}/v1`,
		});
		await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/things' },
			caller: 'test',
		});
		expect(server.requests.at(-1)!.url).toBe('/v1/things');

		const escaped = await calls.call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'get',
			input: { path: '/../admin' },
			caller: 'test',
		});
		expect(escaped).toMatchObject({
			outcome: 'refused',
			errorClass: 'invalid-input',
		});
	});

	it('writes the call log without any body and moves the last call time', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: base(),
		});
		await callService(shared.repository, vault, LOOPBACK).call({
			tenantId: TENANT,
			instanceId: instance.id,
			operation: 'post',
			input: { path: '/things', body: { name: 'Acme' } },
			caller: 'test',
			callerRef: 'drawer',
		});
		const service = instanceService(shared.repository, vault);
		const [logged] = await service.listCalls(TENANT);
		expect(logged).toMatchObject({
			operation: 'post',
			caller: 'test',
			callerRef: 'drawer',
			outcome: 'succeeded',
			status: 200,
			requestBytes: 15,
		});
		expect(logged!.responseBytes).toBeGreaterThan(0);
		expect(JSON.stringify(logged)).not.toContain('Acme');
		const [stored] = await service.list(TENANT);
		expect(stored!.lastCallAt).not.toBeNull();
	});
});
