import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import {
	CONNECTORS_DEFINITIONS_CAPABILITY,
	createConnectorDefinitionRegistry,
	type ConnectorDefinitionRegistry,
} from '../src/domain/definitions.ts';
import {
	CONNECTORS_INSTANCES_CAPABILITY,
	type ConnectorInstancesCapability,
	type ConnectorModuleInstanceInput,
} from '../src/domain/instances.ts';
import type { ConnectorDefinition } from '../src/domain/types.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	ConnectorsService,
	moduleInstanceId,
} from '../src/services/connectors-service.ts';
import { credentialContext } from '../src/services/credential-vault.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import { testVault } from './support/harness.ts';

const TENANT = 'tenant-module';
const OTHER = 'tenant-elsewhere';
const MODULE = 'sample.core';
const SECRET = 'module-secret-0001';

function definition(
	key: string,
	moduleId: string,
	label: string,
): ConnectorDefinition {
	return {
		key,
		moduleId,
		label,
		authKinds: ['none', 'api-key', 'bearer'],
		operations: [
			{
				key: 'search',
				label: 'Search',
				method: 'GET',
				path: '/search',
				inputSchema: { type: 'object' },
				outputSchema: { type: 'object' },
			},
		],
		defaultAllowedHosts: [],
	};
}

const OWN = definition('sample-search', MODULE, 'Sample search');
const OWN_FETCH = definition('sample-fetch', MODULE, 'Sample fetch');
const FOREIGN = definition('other-search', 'other.core', 'Other search');

let shared: ConnectorsTestDatabase;
let registry: ConnectorDefinitionRegistry;
let clock = 1_000;
let invalidated: string[] = [];

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	registry = createConnectorDefinitionRegistry();
	for (const entry of [OWN, OWN_FETCH, FOREIGN]) registry.register(entry);
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	invalidated = [];
	await shared.reset();
});

function service(): ConnectorsService {
	return new ConnectorsService({
		repository: shared.repository,
		vault: testVault(),
		definitions: () => registry,
		invalidate: (tenantId, instanceId) =>
			invalidated.push(`${tenantId}:${instanceId}`),
		now: () => (clock += 1),
	});
}

function input(
	overrides: Partial<ConnectorModuleInstanceInput> = {},
): ConnectorModuleInstanceInput {
	return {
		tenantId: TENANT,
		moduleId: MODULE,
		key: 'searxng',
		definition: OWN.key,
		baseUrl: 'https://search.example.test/',
		credentials: { kind: 'api-key', header: 'x-api-key', value: SECRET },
		allowedHosts: [],
		allowAgents: false,
		allowWorkflows: false,
		actor: 'account-owner',
		...overrides,
	};
}

async function auditActions(tenantId: string, id: string) {
	return (await shared.repository.listAudit(tenantId, id, 50))
		.map((event) => event.action)
		.reverse();
}

describe('CONNECTORS-MODULE-INSTANCE', () => {
	it('keeps one sealed instance per workspace and module key and describes it without the credential', async () => {
		const id = moduleInstanceId(TENANT, MODULE, 'searxng');
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(moduleInstanceId(OTHER, MODULE, 'searxng')).not.toBe(id);

		const created = await service().upsertModuleInstance(
			input({ allowAgents: true, allowWorkflows: true }),
		);
		expect(created).toEqual({
			id,
			moduleId: MODULE,
			key: 'searxng',
			definition: OWN.key,
			name: 'Sample search (sample.core)',
			baseUrl: 'https://search.example.test/',
			authKind: 'api-key',
			hasCredentials: true,
			allowedHosts: ['search.example.test'],
			allowAgents: true,
			allowWorkflows: true,
			status: 'active',
			updatedAt: expect.any(Number),
		});
		const again = await service().upsertModuleInstance(
			input({ allowAgents: true, allowWorkflows: true }),
		);
		const described = await service().describeModuleInstance({
			tenantId: TENANT,
			moduleId: MODULE,
			key: 'searxng',
		});

		expect(again.id).toBe(id);
		expect(described).toEqual(again);
		for (const answer of [created, again, described]) {
			expect(JSON.stringify(answer)).not.toContain(SECRET);
		}
		expect(await service().list(TENANT, { limit: 200 })).toHaveLength(1);
		expect(
			await service().describeModuleInstance({
				tenantId: OTHER,
				moduleId: MODULE,
				key: 'searxng',
			}),
		).toBeNull();
		expect(await auditActions(TENANT, id)).toEqual([
			'instance.created',
			'instance.consent-changed',
			'instance.updated',
		]);
	});

	it('keeps the sealed credential without credentials and replaces it, kind included, with them', async () => {
		const vault = testVault();
		const id = moduleInstanceId(TENANT, MODULE, 'searxng');
		await service().upsertModuleInstance(input());
		const first = await shared.repository.findInstance(TENANT, id);

		const kept = await service().upsertModuleInstance(
			input({
				credentials: undefined,
				baseUrl: 'https://search.example.test/v2',
			}),
		);
		const afterKeep = await shared.repository.findInstance(TENANT, id);
		expect(kept).toMatchObject({
			authKind: 'api-key',
			hasCredentials: true,
			baseUrl: 'https://search.example.test/v2',
		});
		expect(afterKeep?.credentialFingerprint).toBe(first?.credentialFingerprint);

		const replaced = await service().upsertModuleInstance(
			input({ credentials: { kind: 'bearer', token: 'bearer-secret-0002' } }),
		);
		const afterReplace = await shared.repository.findInstance(TENANT, id);
		expect(replaced).toMatchObject({
			authKind: 'bearer',
			hasCredentials: true,
		});
		expect(JSON.stringify(replaced)).not.toContain('bearer-secret-0002');
		expect(afterReplace?.authKind).toBe('bearer');
		expect(afterReplace?.credentialFingerprint).not.toBe(
			first?.credentialFingerprint,
		);
		expect(
			JSON.parse(
				vault.open(afterReplace!.credential!, credentialContext(TENANT, id)),
			),
		).toEqual({ kind: 'bearer', token: 'bearer-secret-0002' });
		expect(invalidated).toContain(`${TENANT}:${id}`);

		const cleared = await service().upsertModuleInstance(
			input({ credentials: { kind: 'none' } }),
		);
		expect(cleared).toMatchObject({ authKind: 'none', hasCredentials: false });
		expect((await shared.repository.findInstance(TENANT, id))?.credential).toBe(
			null,
		);
	});

	it('moves the consent flags to the values given with an audit row only when one moved', async () => {
		const id = moduleInstanceId(TENANT, MODULE, 'searxng');
		await service().upsertModuleInstance(input());
		expect(await auditActions(TENANT, id)).toEqual(['instance.created']);

		const agents = await service().upsertModuleInstance(
			input({ credentials: undefined, allowAgents: true }),
		);
		const same = await service().upsertModuleInstance(
			input({ credentials: undefined, allowAgents: true }),
		);
		const withdrawn = await service().upsertModuleInstance(
			input({ credentials: undefined, allowWorkflows: true }),
		);

		expect([agents, same, withdrawn].map((entry) => entry.allowAgents)).toEqual(
			[true, true, false],
		);
		expect(withdrawn.allowWorkflows).toBe(true);
		expect(await auditActions(TENANT, id)).toEqual([
			'instance.created',
			'instance.updated',
			'instance.consent-changed',
			'instance.updated',
			'instance.updated',
			'instance.consent-changed',
		]);
	});

	it('refuses a foreign definition, a key holding another definition and an unsupported kind, writing nothing', async () => {
		await expect(
			service().upsertModuleInstance(input({ definition: FOREIGN.key })),
		).rejects.toMatchObject({ code: 'DEFINITION_FOREIGN', status: 403 });
		await expect(
			service().upsertModuleInstance(input({ definition: 'unregistered' })),
		).rejects.toMatchObject({ code: 'DEFINITION_UNKNOWN' });
		await expect(
			service().upsertModuleInstance(
				input({
					credentials: {
						kind: 'oauth2-client-credentials',
						tokenUrl: 'https://search.example.test/token',
						clientId: 'client',
						clientSecret: SECRET,
					},
				}),
			),
		).rejects.toMatchObject({ code: 'AUTH_KIND_UNSUPPORTED' });
		await expect(
			service().upsertModuleInstance(input({ key: 'Not A Key' })),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		expect(await service().list(TENANT, { limit: 200 })).toEqual([]);

		const id = moduleInstanceId(TENANT, MODULE, 'searxng');
		await service().upsertModuleInstance(input());
		await expect(
			service().upsertModuleInstance(
				input({
					definition: OWN_FETCH.key,
					baseUrl: 'https://fetch.example.test/',
				}),
			),
		).rejects.toMatchObject({ code: 'DEFINITION_FOREIGN', status: 403 });
		expect(await shared.repository.findInstance(TENANT, id)).toMatchObject({
			definitionKey: OWN.key,
			baseUrl: 'https://search.example.test/',
		});
		expect(await auditActions(TENANT, id)).toEqual(['instance.created']);
	});

	it('leaves an instance the owner disabled disabled', async () => {
		const created = await service().upsertModuleInstance(input());
		await service().disable(TENANT, 'account-owner', created.id);

		const upserted = await service().upsertModuleInstance(
			input({ allowAgents: true }),
		);

		expect(upserted.status).toBe('disabled');
		expect(upserted.allowAgents).toBe(true);
	});

	it('is registered by the composition under connectors.instances.v1', async () => {
		const registered = new Map<string, unknown>();
		const composition = createServerComposition({
			environment: { NODE_ENV: 'test' },
			workspaceRoot: process.cwd(),
			auth: { service: async () => ({}) },
			settings: {},
			databases: shared.databases,
			agentTools: { register: () => undefined },
			dataClasses: { declare: () => undefined },
			capabilities: {
				register: (id: string, value: unknown) => registered.set(id, value),
				get: (id: string) => registered.get(id) ?? null,
			},
		} as unknown as PlatformServerContext);
		try {
			(
				registered.get(CONNECTORS_DEFINITIONS_CAPABILITY) as {
					register(entry: ConnectorDefinition): void;
				}
			).register(OWN);
			const capability = registered.get(
				CONNECTORS_INSTANCES_CAPABILITY,
			) as ConnectorInstancesCapability;

			const answer = await capability.upsertModuleInstance(input());

			expect(answer).toMatchObject({
				id: moduleInstanceId(TENANT, MODULE, 'searxng'),
				hasCredentials: true,
			});
			expect(
				await capability.describeModuleInstance({
					tenantId: TENANT,
					moduleId: MODULE,
					key: 'searxng',
				}),
			).toEqual(answer);
		} finally {
			await composition.dispose?.();
		}
	});
});
