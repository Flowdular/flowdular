import { describe, expect, it, vi } from 'vitest';
import type { ProviderReadinessResult } from '@coreloom/harness';
import type { AgentProviderModelConfiguration } from '../src/domain/types.ts';
import { AesGcmCredentialVault } from '../src/services/credential-vault.ts';
import { SqliteProviderRepository } from '../src/services/provider-repository.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import { SqliteAgentRepository } from '../src/services/sqlite-repository.ts';
import { modelReadinessState } from '../src/client/presentation.ts';

const tenantId = 'tenant-providers';
const actor = 'owner-providers';

const models: readonly AgentProviderModelConfiguration[] = [
	{
		id: 'gpt-4o-mini',
		label: 'GPT-4o mini',
		enabled: true,
		supportsTools: true,
		supportsStreaming: true,
		supportsWebSearch: false,
	},
];

function connections(
	now: () => number,
	probe?: () => Promise<ProviderReadinessResult>,
) {
	const repository = new SqliteProviderRepository(':memory:');
	const service = new AgentProviderService(
		repository,
		new AesGcmCredentialVault(Buffer.alloc(32, 3)),
		new SqliteAgentRepository(':memory:'),
		{
			hostAllowlist: new Set<string>(),
			readinessTtlMs: 60_000,
			readinessTimeoutMs: 1_000,
			now,
			...(probe ? { probe } : {}),
		},
	);
	const created = service.create(tenantId, actor, {
		key: 'primary-openai',
		name: 'Primary OpenAI',
		kind: 'openai',
		credential: 'sk-provider-test-credential',
		models,
	});
	return { repository, service, created };
}

describe('provider connection lifecycle', () => {
	it('enables a connection once its readiness is proven', () => {
		const now = 1_700_000_000_000;
		const { repository, service, created } = connections(() => now);
		expect(created.enabled).toBe(false);

		const tested = repository.recordReadiness(
			tenantId,
			created.id,
			'gpt-4o-mini',
			{ status: 'healthy', latencyMs: 412, errorCode: null, checkedAt: now },
			actor,
			now,
		);

		const enabled = service.update(tenantId, actor, {
			id: created.id,
			expectedRevision: tested.revision,
			name: created.name,
			enabled: true,
			models,
		});

		expect(enabled.enabled).toBe(true);
		expect(enabled.models[0]?.readiness.status).toBe('healthy');
	});

	it('defaults the temperature flag from the model catalog', () => {
		const now = 1_700_000_000_000;
		const { service } = connections(() => now);
		const anthropic = service.create(tenantId, actor, {
			key: 'anthropic',
			name: 'Anthropic',
			kind: 'anthropic',
			credential: 'sk-ant-provider-test-credential',
			models: [
				{ ...models[0]!, id: 'claude-sonnet-5', label: 'Sonnet' },
				{
					...models[0]!,
					id: 'claude-opus-5',
					label: 'Opus',
					supportsTemperature: true,
				},
			],
		});
		expect(
			anthropic.models.map((model) => [model.id, model.supportsTemperature]),
		).toEqual([
			['claude-sonnet-5', false],
			['claude-opus-5', true],
		]);
		const openai = service.create(tenantId, actor, {
			key: 'openai-mixed',
			name: 'OpenAI mixed',
			kind: 'openai',
			credential: 'sk-provider-test-credential',
			models: [
				{ ...models[0]!, id: 'gpt-4o-mini', label: 'Chat' },
				{ ...models[0]!, id: 'gpt-5-mini', label: 'Reasoning' },
			],
		});
		expect(
			openai.models.map((model) => [model.id, model.supportsTemperature]),
		).toEqual([
			['gpt-4o-mini', true],
			['gpt-5-mini', false],
		]);
	});

	it('refuses to enable a connection that was never tested', () => {
		const now = 1_700_000_000_000;
		const { service, created } = connections(() => now);
		expect(() =>
			service.update(tenantId, actor, {
				id: created.id,
				expectedRevision: created.revision,
				name: created.name,
				enabled: true,
				models,
			}),
		).toThrow(
			'Test at least one enabled model before enabling the connection.',
		);
	});
});

function healthy(): Promise<ProviderReadinessResult> {
	return Promise.resolve({
		healthy: true,
		latencyMs: 20,
		errorCode: null,
		detail: null,
	});
}

function unhealthy(): Promise<ProviderReadinessResult> {
	return Promise.resolve({
		healthy: false,
		latencyMs: 20,
		errorCode: 'PROVIDER_AUTHENTICATION_FAILED',
		detail: null,
	});
}

async function enabledConnection(
	now: () => number,
	probe: () => Promise<ProviderReadinessResult>,
) {
	const { repository, service, created } = connections(now, probe);
	const tested = repository.recordReadiness(
		tenantId,
		created.id,
		'gpt-4o-mini',
		{ status: 'healthy', latencyMs: 12, errorCode: null, checkedAt: now() },
		actor,
		now(),
	);
	const enabled = service.update(tenantId, actor, {
		id: created.id,
		expectedRevision: tested.revision,
		name: created.name,
		enabled: true,
		models,
	});
	return { repository, service, enabled };
}

describe('readiness expiry at enqueue', () => {
	it('re-tests a stale model once instead of rejecting the run', async () => {
		let now = 1_700_000_000_000;
		const probe = vi.fn(healthy);
		const { service, enabled } = await enabledConnection(() => now, probe);
		now += 120_000;
		expect(() =>
			service.assertUsable(tenantId, enabled.id, 'gpt-4o-mini'),
		).toThrow(/expired/);
		await Promise.all([
			service.ensureUsable(tenantId, enabled.id, 'gpt-4o-mini', actor),
			service.ensureUsable(tenantId, enabled.id, 'gpt-4o-mini', actor),
		]);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(
			service.get(tenantId, enabled.id)?.models[0]?.readiness.checkedAt,
		).toBe(now);
		expect(() =>
			service.assertUsable(tenantId, enabled.id, 'gpt-4o-mini'),
		).not.toThrow();
	});

	it('keeps the 409 when the automatic re-test fails', async () => {
		let now = 1_700_000_000_000;
		const { service, enabled } = await enabledConnection(() => now, unhealthy);
		now += 120_000;
		await expect(
			service.ensureUsable(tenantId, enabled.id, 'gpt-4o-mini', actor),
		).rejects.toMatchObject({
			code: 'PROVIDER_READINESS_REQUIRED',
			status: 409,
		});
		expect(service.get(tenantId, enabled.id)?.models[0]?.readiness.status).toBe(
			'unhealthy',
		);
	});

	it('does not re-test a model that never passed', async () => {
		const now = 1_700_000_000_000;
		const probe = vi.fn(healthy);
		const { service, created } = connections(() => now, probe);
		await expect(
			service.ensureUsable(tenantId, created.id, 'gpt-4o-mini', actor),
		).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
		expect(probe).not.toHaveBeenCalled();
	});

	it('treats a successful run as fresh readiness evidence', async () => {
		let now = 1_700_000_000_000;
		const probe = vi.fn(healthy);
		const { service, enabled } = await enabledConnection(() => now, probe);
		now += 120_000;
		service.recordRunSuccess(tenantId, enabled.id, 'gpt-4o-mini', now, 850);
		expect(() =>
			service.assertUsable(tenantId, enabled.id, 'gpt-4o-mini'),
		).not.toThrow();
		const refreshed = service.get(tenantId, enabled.id)!;
		expect(refreshed.models[0]?.readiness).toMatchObject({
			status: 'healthy',
			checkedAt: now,
			latencyMs: 850,
		});
		expect(refreshed.revision).toBe(enabled.revision);
		expect(probe).not.toHaveBeenCalled();
	});
});

describe('model readiness presentation', () => {
	const proven = {
		status: 'healthy',
		latencyMs: 12,
		errorCode: null,
		checkedAt: 1_000,
	} as const;

	it('separates fresh evidence from evidence that expired', () => {
		expect(modelReadinessState(proven, 500, 1_400)).toBe('ready');
		expect(modelReadinessState(proven, 500, 1_600)).toBe('stale');
		expect(
			modelReadinessState(
				{
					status: 'unknown',
					latencyMs: null,
					errorCode: null,
					checkedAt: null,
				},
				500,
				1_400,
			),
		).toBe('untested');
		expect(
			modelReadinessState(
				{
					status: 'unhealthy',
					latencyMs: null,
					errorCode: 'PROVIDER_REQUEST_REJECTED',
					checkedAt: 1_000,
				},
				500,
				1_400,
			),
		).toBe('failing');
	});
});
