import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionDefinition } from '@coreloom/harness';
import type { AgentDefinition, AgentRun } from '../src/domain/types.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import {
	providerHostAllowlist,
	validateCompatibleBaseUrl,
} from '../src/services/outbound-policy.ts';
import { AgentProviderBroker } from '../src/services/provider-broker.ts';
import { SqliteProviderRepository } from '../src/services/provider-repository.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import { AgentRunGrantAuthority } from '../src/services/run-grant.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';

const tenantId = 'tenant-security';
const workerId = 'worker:security';

function definition(now: number): AgentDefinition {
	return {
		id: 'agent-security',
		tenantId,
		key: 'security-agent',
		name: 'Security agent',
		description: 'Security boundary test agent.',
		instructions: 'Complete only the explicitly authorized security test.',
		provider: 'local-simulation',
		model: 'deterministic-v1',
		allowedTools: [],
		skillIds: [],
		maxSteps: 2,
		timeoutMs: 1_000,
		temperature: 0,
		maxOutputTokens: 4_096,
		status: 'active',
		revision: 1,
		createdBy: 'owner-security',
		createdAt: now,
		updatedBy: 'owner-security',
		updatedAt: now,
	};
}

function run(
	agent: AgentDefinition,
	now: number,
): {
	readonly run: AgentRun;
	readonly definition: AgentExecutionDefinition;
} {
	return {
		run: {
			id: 'run-security',
			tenantId,
			agentId: agent.id,
			agentName: agent.name,
			agentRevision: agent.revision,
			trigger: 'service',
			status: 'queued',
			input: 'Perform the security test.',
			output: null,
			structuredOutput: null,
			outputContract: { kind: 'text' },
			workflowRunId: null,
			provider: agent.provider,
			model: agent.model,
			requestedBy: 'owner-security',
			requestedActor: {
				kind: 'user',
				id: 'owner-security',
				label: 'owner-security',
			},
			authorizationSubject: {
				kind: 'user',
				id: 'owner-security',
				label: 'owner-security',
			},
			permissionSnapshot: ['agents.runs.execute'],
			toolGrants: [],
			skillSnapshots: [],
			usage: null,
			failureCode: null,
			failureMessage: null,
			attempt: 0,
			queuedAt: now,
			startedAt: null,
			completedAt: null,
			leaseExpiresAt: null,
		},
		definition: {
			id: agent.id,
			name: agent.name,
			revision: agent.revision,
			instructions: agent.instructions,
			provider: agent.provider,
			model: agent.model,
			allowedTools: [],
			maxSteps: agent.maxSteps,
			timeoutMs: agent.timeoutMs,
			temperature: agent.temperature,
		},
	};
}

describe('agent security boundaries', () => {
	it('rolls back run settlement when its audit evidence cannot be written', () => {
		const directory = mkdtempSync(join(tmpdir(), 'agents-run-audit-'));
		const path = join(directory, 'agents.db');
		const repository = new SqliteAgentRepository(path);
		const now = 10_000;
		const agent = repository.createAgent(definition(now));
		repository.enqueueRun(run(agent, now), null, {
			tenantId,
			actorId: 'owner-security',
			action: 'agent-run.queued',
			subjectType: 'agent-run',
			subjectId: 'run-security',
			metadata: {},
			occurredAt: now,
		});
		repository.claimRun(tenantId, 'run-security', workerId, now, now + 5_000, {
			tenantId,
			actorId: workerId,
			action: 'agent-run.claimed',
			subjectType: 'agent-run',
			subjectId: 'run-security',
			metadata: {},
			occurredAt: now,
		});
		const fault = new DatabaseSync(path);
		fault.exec(`CREATE TRIGGER fail_run_audit
		 BEFORE INSERT ON agent_audit_events_v4
		 BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
		fault.close();

		expect(() =>
			repository.completeRun(
				tenantId,
				'run-security',
				workerId,
				{
					output: 'done',
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					finishReason: 'stop',
					startedAt: now,
					completedAt: now + 1,
					events: [],
				},
				{
					tenantId,
					actorId: workerId,
					action: 'agent-run.succeeded',
					subjectType: 'agent-run',
					subjectId: 'run-security',
					metadata: {},
					occurredAt: now + 1,
				},
			),
		).toThrow('audit unavailable');
		expect(repository.getRun(tenantId, 'run-security')?.status).toBe('running');
		const inspect = new DatabaseSync(path, { readOnly: true });
		expect(
			inspect.prepare('SELECT count(*) AS count FROM agent_run_costs').get(),
		).toEqual({ count: 0 });
		inspect.close();
		repository.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it('encrypts credentials with tenant-bound authenticated context', () => {
		const vault = new AesGcmCredentialVault(Buffer.alloc(32, 7));
		const secret = 'sk-security-boundary-value';
		const envelope = vault.encrypt(secret, 'tenant-a:provider-a:openai');
		expect(JSON.stringify(envelope)).not.toContain(secret);
		expect(vault.decrypt(envelope, 'tenant-a:provider-a:openai')).toBe(secret);
		expect(() =>
			vault.decrypt(envelope, 'tenant-b:provider-a:openai'),
		).toThrow();
	});

	it('requires an exact public HTTPS allowlist entry for compatible providers', () => {
		const allowlist = providerHostAllowlist('models.example.com');
		expect(
			validateCompatibleBaseUrl('https://models.example.com/v1', allowlist)
				.hostname,
		).toBe('models.example.com');
		expect(() =>
			validateCompatibleBaseUrl('http://models.example.com/v1', allowlist),
		).toThrowError(/public HTTPS hostname/);
		expect(() =>
			validateCompatibleBaseUrl('https://127.0.0.1/v1', allowlist),
		).toThrowError(/public HTTPS hostname/);
		expect(() =>
			validateCompatibleBaseUrl('https://other.example.com/v1', allowlist),
		).toThrowError(/not present/);
	});

	it('consumes a lease-bound run grant once and rejects replay', async () => {
		let now = 10_000;
		const repository = new SqliteAgentRepository(':memory:');
		const agent = repository.createAgent(definition(now));
		repository.enqueueRun(run(agent, now), null, {
			tenantId,
			actorId: 'owner-security',
			action: 'agent-run.queued',
			subjectType: 'agent-run',
			subjectId: 'run-security',
			metadata: {},
			occurredAt: now,
		});
		const claimed = repository.claimRun(
			tenantId,
			'run-security',
			workerId,
			now,
			now + 5_000,
			{
				tenantId,
				actorId: workerId,
				action: 'agent-run.claimed',
				subjectType: 'agent-run',
				subjectId: 'run-security',
				metadata: {},
				occurredAt: now,
			},
		)!;
		const grants = new AgentRunGrantAuthority(
			Buffer.alloc(32, 9),
			3_000,
			() => now,
		);
		const providerRepository = new SqliteProviderRepository(':memory:');
		const providers = new AgentProviderService(
			providerRepository,
			new AesGcmCredentialVault(Buffer.alloc(32, 5)),
			repository,
			{
				hostAllowlist: new Set(),
				readinessTtlMs: 60_000,
				readinessTimeoutMs: 1_000,
				now: () => now,
			},
		);
		const broker = new AgentProviderBroker(
			grants,
			repository,
			providers,
			() => now,
		);
		const grant = grants.issue({
			tenantId,
			runId: claimed.run.id,
			providerId: claimed.run.provider,
			modelId: claimed.run.model,
			workerId,
			attempt: claimed.run.attempt,
			permissions: claimed.run.permissionSnapshot,
			toolGrants: claimed.run.toolGrants,
			leaseExpiresAt: claimed.run.leaseExpiresAt!,
		});
		const exchanged = await broker.exchange(grant.token);
		expect(exchanged.provider).toBeNull();
		await expect(broker.exchange(grant.token)).rejects.toMatchObject({
			code: 'RUN_GRANT_REJECTED',
		});
		now = grant.claims.expiresAt + 1;
		expect(() => grants.verify(grant.token)).toThrowError(/expired/);
		expect(repository.verifyAuditChain(tenantId)).toBe(true);
	});
});
