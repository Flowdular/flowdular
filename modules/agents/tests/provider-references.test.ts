import { randomUUID } from 'node:crypto';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { AgentHarness } from '@flowdular/harness';
import { AgentService } from '../src/services/agent-service.ts';
import { AgentWorker } from '../src/services/worker.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import { defineAgent } from '../src/server/define-agent.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

vi.mock('node:crypto', async (original) => {
	const crypto = await original<typeof import('node:crypto')>();
	return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

let database: AgentsTestDatabase;
let service: AgentService;
let providers: AgentProviderService;
let worker: AgentWorker;
const tenant = 'provider-reference-tenant';
const actor = 'provider-reference-owner';
const model = 'test-model';
const input: CreateAgentInput = {
	key: 'provider-reference',
	name: 'Provider reference',
	description: 'Tests provider selection without external calls.',
	instructions: 'Return a bounded answer for this test.',
	provider: 'local-simulation',
	model: 'deterministic-v1',
	allowedTools: [],
	procedureIds: [],
	maxSteps: 2,
	timeoutMs: 1000,
	temperature: 0,
	status: 'draft',
};

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});
beforeEach(async () => {
	await database.truncate();
	const harness = new AgentHarness({ providers: [] });
	worker = new AgentWorker(database.repository, harness, {
		workerId: 'worker:provider-references',
		concurrency: 1,
		leaseMs: 1000,
	});
	providers = new AgentProviderService(
		database.providers,
		new AesGcmCredentialVault(Buffer.alloc(32, 3)),
		database.repository,
		{
			hostAllowlist: new Set(),
			readinessTtlMs: 60000,
			readinessTimeoutMs: 1000,
			probe: async () => {
				throw new Error('Unexpected external probe');
			},
		},
	);
	service = new AgentService(database.repository, harness, worker, providers);
});
afterEach(async () => {
	vi.mocked(randomUUID).mockClear();
	await worker.dispose();
});
afterAll(async () => {
	await database.dispose();
});

async function connection(first = '0') {
	vi.mocked(randomUUID).mockReturnValueOnce(
		`${first}1234567-1234-4123-8123-123456789abc`,
	);
	return providers.create(tenant, actor, {
		key: 'openai-' + first,
		name: 'OpenAI test',
		kind: 'openai',
		credential: 'test-credential-only',
		models: [
			{
				id: model,
				label: 'Test model',
				enabled: true,
				supportsTools: true,
				supportsStreaming: true,
				supportsWebSearch: false,
			},
		],
	});
}

describe('provider connection references in agent definitions', () => {
	it.each(['0', '7', 'a'])(
		'creates a draft with a generated provider ID starting with %s',
		async (first) => {
			const provider = await connection(first);
			const agent = await service.createAgent(tenant, actor, {
				...input,
				provider: provider.id,
				model,
			});
			expect(agent).toMatchObject({
				provider: provider.id,
				model,
				status: 'draft',
			});
			expect((await service.listAgents(tenant))[0]?.provider).toBe(provider.id);
		},
	);

	it('updates and archives an existing draft without requiring the provider to be enabled', async () => {
		const provider = await connection();
		const agent = await service.createAgent(tenant, actor, input);
		const updated = await service.updateAgent(tenant, agent.id, actor, {
			...input,
			provider: provider.id,
			model,
			expectedRevision: 1,
		});
		expect(updated.provider).toBe(provider.id);
		await expect(
			service.updateAgent(tenant, agent.id, actor, {
				...input,
				provider: provider.id,
				model,
				status: 'active',
				expectedRevision: 2,
			}),
		).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
		expect(
			(await service.archiveAgent(tenant, agent.id, actor, 2)).status,
		).toBe('archived');
	});

	it('accepts the same reference for a paused module agent while preserving activation checks', async () => {
		const provider = await connection();
		const definition = defineAgent({
			moduleId: 'catalog.core',
			key: 'provider-reference',
			definitionRevision: 1,
			name: input.name,
			description: input.description,
			instructions: input.instructions,
			allowedTools: [],
			limits: {
				maxSteps: 2,
				timeoutMs: 1000,
				temperature: 0,
				maxOutputTokens: 256,
			},
		});
		await service.reconcileModuleAgents([definition]);
		const binding = {
			agentId: definition.id,
			provider: provider.id,
			model,
			enabledTools: [],
			status: 'paused' as const,
			expectedRevision: 0,
		};
		expect(
			await service.configureModuleAgent(tenant, actor, binding),
		).toMatchObject({ provider: provider.id, status: 'paused' });
		await expect(
			service.configureModuleAgent(tenant, actor, {
				...binding,
				status: 'active',
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
	});

	it('still refuses unknown, cross-tenant, unconfigured-model and malformed references', async () => {
		const provider = await connection();
		for (const providerId of ['provider.missing', provider.id]) {
			await expect(
				service.createAgent('other-tenant', actor, {
					...input,
					provider: providerId,
					model,
				}),
			).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });
		}
		await expect(
			service.createAgent(tenant, actor, {
				...input,
				provider: provider.id,
				model: 'missing-model',
			}),
		).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
		for (const providerId of ['x'.repeat(129), 'provider.\u0000bad']) {
			await expect(
				service.createAgent(tenant, actor, {
					...input,
					provider: providerId,
					model,
				}),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
	});
});
