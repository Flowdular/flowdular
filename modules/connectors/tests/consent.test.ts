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

const TENANT = 'tenant-consent';
const ACTOR = 'account-ada';
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

describe('CONNECTORS-CONSENT', () => {
	it('refuses both unattended callers until the owner consents, and then only the consented one', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const calls = callService(shared.repository, vault, LOOPBACK);
		const service = instanceService(shared.repository, vault, (tenant, id) =>
			calls.forget(tenant, id),
		);
		const invoke = (caller: 'workflow' | 'agent') =>
			calls.call({
				tenantId: TENANT,
				instanceId: instance.id,
				operation: 'get',
				input: { path: '/things' },
				caller,
				callerRef: `${caller}-run-1`,
			});

		const before = server.requests.length;
		expect(await invoke('workflow')).toMatchObject({
			outcome: 'refused',
			errorClass: 'consent-missing',
		});
		expect(await invoke('agent')).toMatchObject({
			outcome: 'refused',
			errorClass: 'consent-missing',
		});
		expect(server.requests.length).toBe(before);

		const consented = await service.consent(TENANT, ACTOR, instance.id, {
			allowWorkflows: true,
			allowAgents: false,
			confirmed: true,
		});
		expect(consented).toMatchObject({
			allowWorkflows: true,
			allowAgents: false,
		});

		expect(await invoke('workflow')).toMatchObject({
			outcome: 'succeeded',
			status: 200,
		});
		expect(await invoke('agent')).toMatchObject({
			outcome: 'refused',
			errorClass: 'consent-missing',
		});
		expect(server.requests.length).toBe(before + 1);

		const log = await service.listCalls(TENANT);
		expect(
			log.map((call) => [call.caller, call.outcome, call.callerRef]),
		).toEqual([
			['agent', 'refused', 'agent-run-1'],
			['workflow', 'succeeded', 'workflow-run-1'],
			['agent', 'refused', 'agent-run-1'],
			['workflow', 'refused', 'workflow-run-1'],
		]);
	});

	it('refuses a consent change without an explicit confirmation', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const service = instanceService(shared.repository, vault);
		await expect(
			service.consent(TENANT, ACTOR, instance.id, {
				allowWorkflows: true,
				allowAgents: true,
				confirmed: false,
			}),
		).rejects.toMatchObject({ code: 'CONSENT_NOT_CONFIRMED' });
		expect((await service.list(TENANT))[0]).toMatchObject({
			allowWorkflows: false,
			allowAgents: false,
		});
	});

	it('records every consent change as an audit row', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
		});
		const service = instanceService(shared.repository, vault);
		await service.consent(TENANT, ACTOR, instance.id, {
			allowWorkflows: true,
			allowAgents: true,
			confirmed: true,
		});
		await service.consent(TENANT, ACTOR, instance.id, {
			allowWorkflows: false,
			allowAgents: false,
			confirmed: true,
		});
		const audit = (await service.listAudit(TENANT, instance.id)).filter(
			(entry) => entry.action === 'instance.consent-changed',
		);
		expect(audit.map((entry) => entry.metadata)).toEqual([
			{ allowWorkflows: false, allowAgents: false },
			{ allowWorkflows: true, allowAgents: true },
		]);
	});

	it('answers the admission question for each caller kind without making a call', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
			allowAgents: true,
		});
		const calls = callService(shared.repository, vault, LOOPBACK);
		const before = server.requests.length;
		expect(await calls.consented(TENANT, instance.id, 'agent')).toBe(true);
		expect(await calls.consented(TENANT, instance.id, 'workflow')).toBe(false);
		expect(await calls.consented(TENANT, instance.id, 'test')).toBe(true);
		expect(await calls.consented('tenant-other', instance.id, 'agent')).toBe(
			false,
		);
		expect(server.requests.length).toBe(before);
	});
});

describe('CONNECTORS-DISABLE', () => {
	it('stops a consented workflow call at once and lets it through again after enabling', async () => {
		const vault = testVault();
		const instance = await seedInstance(shared.repository, vault, {
			tenantId: TENANT,
			baseUrl: testBaseUrl(server),
			allowWorkflows: true,
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
				caller: 'workflow',
				callerRef: 'queued-run',
			});

		expect(await invoke()).toMatchObject({ outcome: 'succeeded' });
		await service.disable(TENANT, ACTOR, instance.id);

		const before = server.requests.length;
		const refused = await invoke();
		expect(refused).toMatchObject({
			outcome: 'refused',
			errorClass: 'instance-disabled',
			status: null,
		});
		expect(server.requests.length).toBe(before);
		expect(await calls.consented(TENANT, instance.id, 'workflow')).toBe(false);

		await service.enable(TENANT, ACTOR, instance.id);
		expect(await invoke()).toMatchObject({ outcome: 'succeeded' });
	});
});
