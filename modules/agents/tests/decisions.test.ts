import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionResult } from '@flowdular/harness/decisions';
import type { AgentProviderModelConfiguration } from '../src/domain/types.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import { AgentDecisionService } from '../src/services/decision-service.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import type {
	MeterCheckResult,
	MeterRecordInput,
	MeterRegistry,
	MeterVerdict,
} from '../src/services/metering.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-decisions';
const OTHER = 'tenant-other-decisions';
const OWNER = 'owner-decisions';

const MODELS: readonly AgentProviderModelConfiguration[] = [
	{
		id: 'jev-latest',
		label: 'Jev',
		enabled: true,
		supportsTools: false,
		supportsStreaming: false,
		supportsWebSearch: false,
	},
];

const QUESTIONS = {
	module: {
		type: 'choice' as const,
		instruction: 'Which module does this change?',
		options: ['catalog.core', 'none_of_these'],
	},
};

const ANSWER: DecisionResult = {
	answers: {
		module: {
			type: 'choice',
			choice: 'catalog.core',
			probabilities: { 'catalog.core': 0.94 },
			confidence: 0.94,
		},
	},
	usage: { inputTokens: 412, outputTokens: 0 },
};

class FakeMeterRegistry implements MeterRegistry {
	readonly records: MeterRecordInput[] = [];
	readonly checks: { meter: string; amount: number }[] = [];
	verdict: MeterVerdict = 'allowed';

	declare(): void {}

	record(input: MeterRecordInput) {
		this.records.push(input);
		return Promise.resolve({ recorded: true, day: '2026-09-21' });
	}

	check(input: { meter: string; amount: number }): Promise<MeterCheckResult> {
		this.checks.push({ meter: input.meter, amount: input.amount });
		return Promise.resolve({
			verdict: this.verdict,
			used: 0,
			limit: this.verdict === 'refused' ? 0 : null,
		});
	}
}

let database: AgentsTestDatabase;

beforeAll(async () => {
	database = await openAgentsTestDatabase();
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await database.dispose();
});

function providerService(now: () => number = () => 1_000) {
	return new AgentProviderService(
		database.providers,
		new AesGcmCredentialVault(Buffer.alloc(32, 5)),
		database.repository,
		{
			hostAllowlist: new Set<string>(),
			readinessTtlMs: 60_000,
			readinessTimeoutMs: 1_000,
			now,
			/* A decision connection is probed with one typed question instead of
			   one completion, and this stands in for that provider. */
			probeDecisions: async () => ({
				healthy: true,
				latencyMs: 12,
				errorCode: null,
				detail: null,
			}),
		},
	);
}

/** A decision connection as an owner would create and then consent to it. */
async function decisionConnection(options?: {
	readonly tenantId?: string;
	readonly enabled?: boolean;
	readonly consented?: boolean;
	readonly key?: string;
	readonly name?: string;
}) {
	const tenantId = options?.tenantId ?? TENANT;
	const service = providerService();
	const created = await service.create(tenantId, OWNER, {
		key: options?.key ?? 'decisions',
		name: options?.name ?? 'TypeSafe decisions',
		kind: 'typesafe',
		credential: 'sk-decisions-test',
		models: MODELS,
	});
	const stored = await database.providers.get(tenantId, created.id);
	await database.providers.update({
		connection: {
			...stored!.connection,
			enabled: options?.enabled ?? true,
			allowWorkflows: options?.consented ?? true,
		},
		credential: stored!.credential,
	});
	return created;
}

function decisions(options?: {
	readonly enabled?: boolean;
	readonly meters?: MeterRegistry;
	readonly ask?: () => Promise<DecisionResult>;
	readonly calls?: { count: number };
}) {
	return new AgentDecisionService(
		database.providers,
		new AesGcmCredentialVault(Buffer.alloc(32, 5)),
		database.repository,
		{
			typedDecisionsEnabled: () => options?.enabled ?? true,
			...(options?.meters ? { meters: () => options.meters! } : {}),
			now: () => 5_000,
			ask: async () => {
				if (options?.calls) options.calls.count += 1;
				return (await options?.ask?.()) ?? ANSWER;
			},
		},
	);
}

function ask(service: AgentDecisionService, tenantId = TENANT) {
	return service.ask({
		tenantId,
		caller: { moduleId: 'workflows.core', ref: 'run-1' },
		state: 'Prices should carry a currency.',
		questions: QUESTIONS,
	});
}

describe('AGENTS-DECISION-PROVIDER', () => {
	it('seals the credential and exposes only its presence and revision', async () => {
		const created = await decisionConnection();

		expect(created).toMatchObject({
			kind: 'typesafe',
			credentialConfigured: true,
			credentialRevision: 1,
			/* Consent is its own act, never part of creating the connection. */
			allowWorkflows: false,
		});
		expect(JSON.stringify(created)).not.toContain('sk-decisions-test');
		const stored = await database.providers.get(TENANT, created.id);
		expect(stored?.credential.ciphertext).not.toContain('sk-decisions-test');
	});
});

describe('AGENTS-DECISION-NOT-A-MODEL', () => {
	it('refuses to exchange a decision connection for a language model', async () => {
		const created = await decisionConnection();

		await expect(
			providerService().resolve(TENANT, created.id, 'jev-latest'),
		).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_A_MODEL' });
	});

	/* Activation and enqueue check the connection through their own paths, so
	   each one refuses on its own rather than relying on the run to fail. */
	it('refuses it where an agent is activated and where a run resolves it', async () => {
		const created = await decisionConnection();
		const service = providerService();

		await expect(
			service.assertUsable(TENANT, created.id, 'jev-latest'),
		).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_A_MODEL' });
		await expect(
			service.ensureUsable(TENANT, created.id, 'jev-latest', OWNER),
		).rejects.toMatchObject({ code: 'DECISION_PROVIDER_NOT_A_MODEL' });
	});
});

describe('decision provider consent through its own APIs', () => {
	/* The switch an owner flips is the provider update, so the service path
	   that carries it is the one a regression would break. */
	it('turns consent on through the provider service and keeps it across an edit', async () => {
		const created = await decisionConnection({ consented: false });
		const service = providerService();
		/* Enabling needs a proven model, and for this kind the proof is one
		   typed question rather than one completion. */
		const probed = await service.test(TENANT, created.id, 'jev-latest', OWNER);
		expect(probed.models[0]?.readiness.status).toBe('healthy');
		const stored = await database.providers.get(TENANT, created.id);

		const consented = await service.update(TENANT, OWNER, {
			id: created.id,
			expectedRevision: stored!.connection.revision,
			name: 'TypeSafe decisions',
			enabled: true,
			models: MODELS,
			allowWorkflows: true,
		});

		expect(consented.allowWorkflows).toBe(true);
		/* An edit that says nothing about consent keeps what the workspace
		   already decided. */
		const renamed = await service.update(TENANT, OWNER, {
			id: created.id,
			expectedRevision: consented.revision,
			name: 'Decisions',
			enabled: true,
			models: MODELS,
		});
		expect(renamed.allowWorkflows).toBe(true);
	});

	it('turns consent off again', async () => {
		const created = await decisionConnection();
		const service = providerService();
		await service.test(TENANT, created.id, 'jev-latest', OWNER);
		const stored = await database.providers.get(TENANT, created.id);

		const withdrawn = await service.update(TENANT, OWNER, {
			id: created.id,
			expectedRevision: stored!.connection.revision,
			name: 'TypeSafe decisions',
			enabled: true,
			models: MODELS,
			allowWorkflows: false,
		});

		expect(withdrawn.allowWorkflows).toBe(false);
		await expect(ask(decisions())).rejects.toMatchObject({
			code: 'DECISION_PROVIDER_NOT_CONSENTED',
		});
	});
});

describe('AGENTS-DECISION-FLAG-OFF', () => {
	it('answers nothing and calls no provider while the flag is off', async () => {
		await decisionConnection();
		const meters = new FakeMeterRegistry();
		const calls = { count: 0 };
		const service = decisions({ enabled: false, meters, calls });

		await expect(ask(service)).rejects.toMatchObject({
			code: 'TYPED_DECISIONS_DISABLED',
		});
		expect(await service.available(TENANT)).toBe(false);
		expect(calls.count).toBe(0);
		expect(meters.checks).toEqual([]);
		expect(meters.records).toEqual([]);
	});
});

describe('AGENTS-DECISION-CONSENT', () => {
	it('refuses a connection the workspace has not consented', async () => {
		await decisionConnection({ consented: false });
		const calls = { count: 0 };
		const service = decisions({ calls });

		await expect(ask(service)).rejects.toMatchObject({
			code: 'DECISION_PROVIDER_NOT_CONSENTED',
		});
		expect(calls.count).toBe(0);
		expect(await service.available(TENANT)).toBe(false);
	});

	/* The repository lists by name, so an unusable connection sorts first here.
	   Reporting the capability as available and then refusing every question
	   would leave a workflow failing for a reason its workspace cannot see. */
	it('uses the consented connection when an unusable one sorts first', async () => {
		await decisionConnection({
			key: 'alpha-decisions',
			name: 'Alpha decisions',
			consented: false,
		});
		const second = await decisionConnection({
			key: 'beta-decisions',
			name: 'Beta decisions',
		});
		const service = decisions();

		const result = await ask(service);

		expect(result.answers.module).toMatchObject({ choice: 'catalog.core' });
		expect(await service.available(TENANT)).toBe(true);
		const events = await database.repository.listAuditEvents(TENANT, 50);
		expect(
			events.find((event) => event.action === 'agent-provider.decision-asked')
				?.subjectId,
		).toBe(second.id);
	});

	it('names consent when the only connection is enabled but unconsented', async () => {
		await decisionConnection({ consented: false });

		await expect(ask(decisions())).rejects.toMatchObject({
			code: 'DECISION_PROVIDER_NOT_CONSENTED',
		});
	});

	it('refuses when the workspace has no enabled decision connection', async () => {
		await decisionConnection({ enabled: false });

		await expect(ask(decisions())).rejects.toMatchObject({
			code: 'DECISION_PROVIDER_NOT_CONFIGURED',
		});
	});
});

describe('AGENTS-DECISION-METER', () => {
	it('refuses a spent allowance before the provider is called', async () => {
		await decisionConnection();
		const meters = new FakeMeterRegistry();
		meters.verdict = 'refused';
		const calls = { count: 0 };

		await expect(ask(decisions({ meters, calls }))).rejects.toMatchObject({
			code: 'METER_LIMIT_EXCEEDED',
		});
		expect(calls.count).toBe(0);
		expect(meters.checks).toEqual([
			{ meter: 'agents.core.decisions', amount: 1 },
		]);
		expect(meters.records).toEqual([]);
	});

	it('counts an answered call once against its caller reference', async () => {
		await decisionConnection();
		const meters = new FakeMeterRegistry();

		const result = await ask(decisions({ meters }));

		expect(result.answers.module).toMatchObject({ choice: 'catalog.core' });
		expect(meters.records).toEqual([
			{
				tenantId: TENANT,
				meter: 'agents.core.decisions',
				amount: 1,
				at: 5_000,
				sourceRef: 'workflows.core:run-1',
			},
		]);
	});
});

describe('AGENTS-DECISION-DENY', () => {
	it('never answers with another workspace connection', async () => {
		await decisionConnection({ tenantId: OTHER });
		const calls = { count: 0 };
		const service = decisions({ calls });

		await expect(ask(service, TENANT)).rejects.toMatchObject({
			code: 'DECISION_PROVIDER_NOT_CONFIGURED',
		});
		expect(calls.count).toBe(0);
		expect(await service.available(TENANT)).toBe(false);
		expect(await service.available(OTHER)).toBe(true);
	});

	it('refuses a request outside the bounds before anything is resolved', async () => {
		await decisionConnection();
		const calls = { count: 0 };
		const service = decisions({ calls });

		await expect(
			service.ask({
				tenantId: TENANT,
				caller: { moduleId: 'workflows.core' },
				state: '',
				questions: QUESTIONS,
			}),
		).rejects.toMatchObject({ code: 'INVALID_DECISION_REQUEST' });
		await expect(
			service.ask({
				tenantId: TENANT,
				caller: { moduleId: 'workflows.core' },
				state: 'anything',
				questions: {},
			}),
		).rejects.toMatchObject({ code: 'INVALID_DECISION_REQUEST' });
		expect(calls.count).toBe(0);
	});
});

describe('AGENTS-DECISION-TRAIL', () => {
	it('records the ask without the state, the questions or the answers', async () => {
		const created = await decisionConnection();

		await ask(decisions());

		const events = await database.repository.listAuditEvents(TENANT, 50);
		const asked = events.filter(
			(event) => event.action === 'agent-provider.decision-asked',
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({
			subjectType: 'agent-provider',
			subjectId: created.id,
			actorId: 'workflows.core',
			metadata: {
				caller: 'workflows.core',
				callerRef: 'run-1',
				questions: 1,
				inputTokens: 412,
			},
		});
		const written = JSON.stringify(asked[0]);
		expect(written).not.toContain('Prices should carry a currency.');
		expect(written).not.toContain('catalog.core');
		expect(written).not.toContain('Which module does this change?');
		await expect(database.repository.verifyAuditChain(TENANT)).resolves.toBe(
			true,
		);
	});
});
