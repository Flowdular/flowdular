import type { DatabaseAdapterLease } from '@flowdular/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentExecutionDefinition } from '@flowdular/harness';
import type { AgentDefinition, AgentRun } from '../src/domain/types.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import {
	providerHostAllowlist,
	validateCompatibleBaseUrl,
} from '../src/services/outbound-policy.ts';
import { AgentProviderBroker } from '../src/services/provider-broker.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import { AgentRunGrantAuthority } from '../src/services/run-grant.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const tenantId = 'tenant-security';
const workerId = 'worker:security';

let database: AgentsTestDatabase;
let owner: DatabaseAdapterLease;
let runtime: DatabaseAdapterLease;

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	owner = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
	runtime = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'runtime',
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await runtime?.release();
	await owner?.release();
	await database.dispose();
});

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
		procedureIds: [],
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
			procedureSnapshots: [],
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
	it('rolls back run settlement when its audit evidence cannot be written', async () => {
		const repository = database.repository;
		const now = 10_000;
		const agent = await repository.createAgent(definition(now));
		await repository.enqueueRun(run(agent, now), null, {
			tenantId,
			actorId: 'owner-security',
			action: 'agent-run.queued',
			subjectType: 'agent-run',
			subjectId: 'run-security',
			metadata: {},
			occurredAt: now,
		});
		await repository.claimRun(
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
		);
		/* The audit trail is the module's own immutability trigger function,
		   pointed at the audit table so every insert into it aborts. */
		await owner.database.execute({
			text: `CREATE TRIGGER fail_run_audit
			       BEFORE INSERT ON agent_audit_events_v4
			       FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('audit unavailable')`,
		});

		try {
			await expect(
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
			).rejects.toThrow('audit unavailable');
		} finally {
			await owner.database.execute({
				text: 'DROP TRIGGER fail_run_audit ON agent_audit_events_v4',
			});
		}

		expect((await repository.getRun(tenantId, 'run-security'))?.status).toBe(
			'running',
		);
		/* count(*) is BIGINT, which the driver hands back as a string. Reading it
		   as a number is exactly the mistake this suite exists to catch. */
		expect(
			Number(
				(
					await owner.database.transaction(
						(transaction) =>
							transaction.query<{ count: number | string }>({
								text: 'SELECT count(*) AS count FROM agent_run_costs',
							}),
						{ access: 'read', tenantId },
					)
				).rows[0]?.count,
			),
		).toBe(0);
	});

	it('encrypts credentials with tenant-bound authenticated context', async () => {
		const vault = new AesGcmCredentialVault(Buffer.alloc(32, 7));
		const secret = 'sk-security-boundary-value';
		const envelope = vault.encrypt(secret, 'tenant-a:provider-a:openai');
		expect(JSON.stringify(envelope)).not.toContain(secret);
		expect(vault.decrypt(envelope, 'tenant-a:provider-a:openai')).toBe(secret);
		expect(() =>
			vault.decrypt(envelope, 'tenant-b:provider-a:openai'),
		).toThrow();
	});

	it('requires an exact public HTTPS allowlist entry for compatible providers', async () => {
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
		const repository = database.repository;
		const agent = await repository.createAgent(definition(now));
		await repository.enqueueRun(run(agent, now), null, {
			tenantId,
			actorId: 'owner-security',
			action: 'agent-run.queued',
			subjectType: 'agent-run',
			subjectId: 'run-security',
			metadata: {},
			occurredAt: now,
		});
		const claimed = (await repository.claimRun(
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
		))!;
		const grants = new AgentRunGrantAuthority(
			Buffer.alloc(32, 9),
			3_000,
			() => now,
		);
		const providers = new AgentProviderService(
			database.providers,
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
		expect(await repository.verifyAuditChain(tenantId)).toBe(true);
	});
});

/* The runtime role is the one every request-time repository call runs on. These
   two cases prove the database refuses on its own, without any repository help:
   a write that names a foreign tenant and a transaction with no tenant at all. */
describe('runtime handle tenant enforcement', () => {
	it('refuses a write that names another tenant', async () => {
		await expect(
			runtime.database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO agent_definitions
						       (id, tenant_id, agent_key, name, description, instructions,
						        provider, model, allowed_tools_json, max_steps, timeout_ms,
						        temperature_milli, status, revision, created_by, created_at,
						        updated_by, updated_at)
						       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
						               $13, $14, $15, $16, $17, $18)`,
						parameters: [
							'forged',
							'tenant-b',
							'forged-agent',
							'Forged',
							'Written under another tenant.',
							'Never runs.',
							'local-simulation',
							'deterministic-v1',
							'[]',
							1,
							1_000,
							0,
							'draft',
							1,
							'owner-a',
							1,
							'owner-a',
							1,
						],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();

		expect(
			(
				await owner.database.transaction(
					(transaction) =>
						transaction.query<{ id: string }>({
							text: 'SELECT id FROM agent_definitions',
						}),
					{ access: 'read', tenantId: 'tenant-b' },
				)
			).rows,
		).toEqual([]);
	});

	it('refuses a transaction that carries no tenant context', async () => {
		await expect(
			runtime.database.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	/* These two tables hang off a tenant-owned parent, so a read by a
	   caller-supplied parent id used to cross tenants. Knowing the id is now
	   worth nothing without the tenant that owns it. */
	it('hides a run procedure snapshot from another tenant that knows the run id', async () => {
		const repository = database.repository;
		const now = 20_000;
		const agent = await repository.createAgent(definition(now));
		const queued = run(agent, now);
		await repository.enqueueRun(
			{
				...queued,
				run: {
					...queued.run,
					procedureSnapshots: [
						{
							id: 'procedure-1',
							key: 'refund-review',
							name: 'Refund review',
							revision: 1,
							requiredTools: [],
						},
					],
				},
			},
			null,
			{
				tenantId,
				actorId: 'owner-security',
				action: 'agent-run.queued',
				subjectType: 'agent-run',
				subjectId: 'run-security',
				metadata: {},
				occurredAt: now,
			},
		);
		expect(
			(await repository.getRun(tenantId, 'run-security'))?.procedureSnapshots,
		).toHaveLength(1);

		expect(await repository.getRun('tenant-other', 'run-security')).toBeNull();
		const snapshots = (forTenant: string) =>
			runtime.database.transaction(
				(transaction) =>
					transaction.query<{ skill_id: string }>({
						text: 'SELECT skill_id FROM agent_run_skill_snapshots WHERE run_id = $1',
						parameters: ['run-security'],
					}),
				{ access: 'read', tenantId: forTenant },
			);
		expect((await snapshots(tenantId)).rows).toEqual([
			{ skill_id: 'procedure-1' },
		]);
		expect((await snapshots('tenant-other')).rows).toEqual([]);
	});

	it('hides provider model readiness from another tenant that knows the provider id', async () => {
		const now = 20_000;
		const providerId = 'provider-security';
		await database.providers.create({
			connection: {
				id: providerId,
				tenantId,
				key: 'primary-openai',
				name: 'Primary OpenAI',
				kind: 'openai',
				enabled: false,
				resourceName: null,
				baseURL: null,
				models: [
					{
						id: 'gpt-4o-mini',
						label: 'GPT-4o mini',
						enabled: true,
						supportsTools: true,
						supportsStreaming: true,
						supportsWebSearch: false,
						supportsTemperature: true,
						readiness: {
							status: 'unknown',
							latencyMs: null,
							errorCode: null,
							checkedAt: null,
						},
					},
				],
				credentialConfigured: true,
				credentialRevision: 1,
				revision: 1,
				createdBy: 'owner-security',
				createdAt: now,
				updatedBy: 'owner-security',
				updatedAt: now,
			},
			credential: {
				keyId: 'key-1',
				iv: 'iv',
				tag: 'tag',
				ciphertext: 'ciphertext',
			},
		});
		await database.providers.recordReadiness(
			tenantId,
			providerId,
			'gpt-4o-mini',
			{ status: 'healthy', latencyMs: 12, errorCode: null, checkedAt: now },
			'owner-security',
			now,
		);

		expect(await database.providers.get('tenant-other', providerId)).toBeNull();
		const readiness = (forTenant: string) =>
			runtime.database.transaction(
				(transaction) =>
					transaction.query<{ model_id: string }>({
						text: 'SELECT model_id FROM agent_provider_model_readiness WHERE provider_id = $1',
						parameters: [providerId],
					}),
				{ access: 'read', tenantId: forTenant },
			);
		expect((await readiness(tenantId)).rows).toEqual([
			{ model_id: 'gpt-4o-mini' },
		]);
		expect((await readiness('tenant-other')).rows).toEqual([]);
	});
});
