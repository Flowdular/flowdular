import { describe, expect, it } from 'vitest';
import { AgentHarness, type AgentProvider } from '@coreloom/harness';
import { AgentService, moduleDefinition } from '../src/index.ts';
import type { CreateAgentInput } from '../src/domain/types.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import { AgentWorker } from '../src/services/worker.ts';

const input: CreateAgentInput = {
	key: 'customer-care',
	name: 'Customer care',
	description: 'Prepares bounded customer service responses.',
	instructions: 'Prepare a factual response and escalate uncertain requests.',
	provider: 'test-provider',
	model: 'test-model',
	allowedTools: [],
	skillIds: [],
	maxSteps: 4,
	timeoutMs: 1_000,
	temperature: 0,
	status: 'draft',
};

function runtime(provider: AgentProvider) {
	const repository = new SqliteAgentRepository(':memory:');
	const harness = new AgentHarness({ providers: [provider] });
	const worker = new AgentWorker(repository, harness, {
		workerId: 'worker:test',
		concurrency: 1,
		leaseMs: 1_000,
	});
	worker.start();
	const service = new AgentService(repository, harness, worker);
	return { repository, service, worker };
}

async function waitForTerminal(
	service: AgentService,
	tenantId: string,
	runId: string,
) {
	for (let index = 0; index < 50; index += 1) {
		const run = service.getRun(tenantId, runId);
		if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('Agent run did not finish in time.');
}

describe('agents.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('agents.core');
	});

	it('versions tenant-scoped definitions and records an audit hash chain', () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				finishReason: 'stop',
			}),
		};
		const { repository, service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		expect(created.status).toBe('draft');
		expect(service.listAgents('tenant-b')).toEqual([]);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: 1,
		});
		expect(active.revision).toBe(2);
		expect(repository.verifyAuditChain('tenant-a')).toBe(true);
		expect(repository.listAuditEvents('tenant-a', 10)).toHaveLength(2);
	});

	it('archives and deletes only unused definitions and skills', () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			}),
		};
		const { repository, service } = runtime(provider);
		const skill = service.createSkill('tenant-a', 'owner-a', {
			key: 'safe-delete',
			name: 'Safe delete',
			description: 'Exercises lifecycle protections.',
			instructions: 'Follow the bounded procedure.',
			requiredTools: [],
			status: 'draft',
		});
		const activeSkill = service.updateSkill('tenant-a', skill.id, 'owner-a', {
			key: skill.key,
			name: skill.name,
			description: skill.description,
			instructions: skill.instructions,
			requiredTools: skill.requiredTools,
			status: 'active',
			expectedRevision: skill.revision,
		});
		const agent = service.createAgent('tenant-a', 'owner-a', {
			...input,
			key: 'safe-delete-agent',
			skillIds: [activeSkill.id],
		});
		const activeAgent = service.updateAgent('tenant-a', agent.id, 'owner-a', {
			...input,
			key: agent.key,
			skillIds: [activeSkill.id],
			status: 'active',
			expectedRevision: agent.revision,
		});
		expect(() =>
			service.archiveSkill(
				'tenant-a',
				activeSkill.id,
				'owner-a',
				activeSkill.revision,
			),
		).toThrow('Remove this skill from every active agent');

		const archivedAgent = service.archiveAgent(
			'tenant-a',
			activeAgent.id,
			'owner-a',
			activeAgent.revision,
		);
		const archivedSkill = service.archiveSkill(
			'tenant-a',
			activeSkill.id,
			'owner-a',
			activeSkill.revision,
		);
		expect(() =>
			service.deleteSkill(
				'tenant-a',
				archivedSkill.id,
				'owner-a',
				archivedSkill.revision,
			),
		).toThrow('Remove this skill from every agent');

		const detachedAgent = service.updateAgent(
			'tenant-a',
			archivedAgent.id,
			'owner-a',
			{
				...input,
				key: archivedAgent.key,
				skillIds: [],
				status: 'archived',
				expectedRevision: archivedAgent.revision,
			},
		);
		service.deleteSkill(
			'tenant-a',
			archivedSkill.id,
			'owner-a',
			archivedSkill.revision,
		);
		service.deleteAgent(
			'tenant-a',
			detachedAgent.id,
			'owner-a',
			detachedAgent.revision,
		);
		expect(service.listSkills('tenant-a')).toEqual([]);
		expect(service.listAgents('tenant-a')).toEqual([]);
		expect(
			repository.listAuditEvents('tenant-a', 20).map((event) => event.action),
		).toEqual(
			expect.arrayContaining([
				'agent.archived',
				'agent.deleted',
				'agent-skill.archived',
				'agent-skill.deleted',
			]),
		);
	});

	it('refuses to delete an archived agent with durable run evidence', async () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			}),
		};
		const { service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: created.revision,
		});
		await service.enqueueRun('tenant-a', 'owner-a', [], {
			agentId: active.id,
			trigger: 'service',
			input: 'Keep this evidence.',
			toolGrants: [],
			idempotencyKey: 'keep-run-evidence',
		});
		const archived = service.archiveAgent(
			'tenant-a',
			active.id,
			'owner-a',
			active.revision,
		);
		expect(() =>
			service.deleteAgent(
				'tenant-a',
				archived.id,
				'owner-a',
				archived.revision,
			),
		).toThrow('run history');
	});

	it('returns a queued run before detached provider work completes', async () => {
		let providerCompleted = false;
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				providerCompleted = true;
				return {
					output: 'Background work completed.',
					usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
					finishReason: 'stop',
				};
			},
		};
		const { repository, service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: created.revision,
		});
		const queued = await service.enqueueRun(
			'tenant-a',
			'owner-a',
			['agents.runs.execute'],
			{
				agentId: active.id,
				trigger: 'workflow',
				input: 'Handle order exception 42.',
				toolGrants: [],
				idempotencyKey: 'order-exception-42',
			},
		);
		expect(queued.status).toBe('queued');
		expect(providerCompleted).toBe(false);
		const completed = await waitForTerminal(service, 'tenant-a', queued.id);
		expect(completed.status).toBe('succeeded');
		expect(completed.output).toBe('Background work completed.');
		expect(completed.events.map((event) => event.type)).toEqual([
			'run.started',
			'provider.started',
			'provider.completed',
			'run.completed',
		]);
		expect(repository.verifyAuditChain('tenant-a')).toBe(true);
	});

	it('deduplicates fire-and-forget requests by tenant idempotency key', async () => {
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async () => ({
				output: 'ok',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			}),
		};
		const { service } = runtime(provider);
		const created = service.createAgent('tenant-a', 'owner-a', input);
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			status: 'active',
			expectedRevision: 1,
		});
		const request = {
			agentId: active.id,
			trigger: 'service' as const,
			input: 'Prepare summary.',
			toolGrants: [],
			idempotencyKey: 'summary-request-0001',
		};
		const first = await service.enqueueRun('tenant-a', 'owner-a', [], request);
		const second = await service.enqueueRun('tenant-a', 'owner-a', [], request);
		expect(second.id).toBe(first.id);
	});

	it('resolves context variables into the run snapshot but keeps the raw template', async () => {
		let seenInstructions = '';
		const provider: AgentProvider = {
			id: 'test-provider',
			execute: async (context) => {
				seenInstructions = context.request.definition.instructions;
				return {
					output: 'ok',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop',
				};
			},
		};
		const { service } = runtime(provider);
		const template =
			'You act for {{ context.tenantName }} on {{ context.today }} as {{ context.user.displayName }}.';
		const created = service.createAgent('tenant-a', 'owner-a', {
			...input,
			instructions: template,
		});
		const active = service.updateAgent('tenant-a', created.id, 'owner-a', {
			...input,
			instructions: template,
			status: 'active',
			expectedRevision: created.revision,
		});
		const queued = await service.enqueueRun(
			'tenant-a',
			'owner-a',
			['agents.runs.execute'],
			{
				agentId: active.id,
				trigger: 'playground',
				input: 'Draft the reply.',
				toolGrants: [],
			},
			{
				tenantName: 'Acme Manufacturing',
				userDisplayName: 'Ada Lovelace',
				userEmail: 'ada@acme.test',
			},
		);
		await waitForTerminal(service, 'tenant-a', queued.id);
		expect(seenInstructions).toContain('You act for Acme Manufacturing on ');
		expect(seenInstructions).toContain('as Ada Lovelace.');
		expect(seenInstructions).toMatch(/on \d{4}-\d{2}-\d{2} as/);
		expect(seenInstructions).not.toContain('{{');
		const stored = service.listAgents('tenant-a')[0];
		expect(stored?.instructions).toBe(template);
	});
});
