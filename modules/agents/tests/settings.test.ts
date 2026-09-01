import { describe, expect, it } from 'vitest';
import {
	AGENTS_MODULE_SETTINGS,
	agentSettings,
	agentsModuleSettingsFromEnvironment,
} from '../src/settings.ts';

describe('agents.core module settings', () => {
	it('declares a valid set of settings', () => {
		expect(AGENTS_MODULE_SETTINGS.moduleId).toBe('agents.core');
		expect(Object.keys(AGENTS_MODULE_SETTINGS.settings).sort()).toEqual([
			'defaultMaxOutputTokens',
			'defaultModel',
			'defaultProvider',
			'providerHostAllowlist',
			'providerReadinessTtlMs',
			'workerConcurrency',
			'workerLeaseMs',
		]);
		for (const definition of Object.values(AGENTS_MODULE_SETTINGS.settings)) {
			expect(definition.label).toBeTruthy();
			expect(definition.description).toBeTruthy();
		}
	});

	it('takes deployment defaults from the environment', () => {
		const declaration = agentsModuleSettingsFromEnvironment({
			OERP_AGENT_WORKER_CONCURRENCY: '4',
			OERP_AGENT_PROVIDER_HOST_ALLOWLIST: 'models.example.com',
		});
		expect(declaration.settings.workerConcurrency?.defaultValue).toBe(4);
		expect(declaration.settings.providerHostAllowlist?.defaultValue).toBe(
			'models.example.com',
		);
		expect(declaration.settings.defaultMaxOutputTokens?.defaultValue).toBe(
			4_096,
		);
	});

	it('falls back to the environment without a settings runtime', () => {
		const reader = agentSettings({
			environment: {
				OERP_AGENT_WORKER_CONCURRENCY: '3',
				OERP_AGENT_PROVIDER_HOST_ALLOWLIST: 'a.example.com, B.example.com',
			},
		});
		expect(reader.workerConcurrency()).toBe(3);
		expect(reader.workerLeaseMs()).toBe(30_000);
		expect([...reader.providerHostAllowlist()]).toEqual([
			'a.example.com',
			'b.example.com',
		]);
		expect(reader.defaultMaxOutputTokens('tenant-a')).toBe(4_096);
		expect(reader.defaultProvider('tenant-a')).toBe('');
	});

	it('reads live values from a settings runtime and survives its failures', () => {
		const values: Record<string, unknown> = {
			workerConcurrency: 7,
			providerHostAllowlist: 'live.example.com',
			defaultMaxOutputTokens: 'not-a-number',
		};
		const reader = agentSettings({
			environment: { OERP_AGENT_WORKER_CONCURRENCY: '3' },
			settings: {
				get: (tenantId: string, moduleId: string, key: string) => {
					if (key === 'defaultModel') throw new Error('store offline');
					expect(moduleId).toBe('agents.core');
					if (key === 'workerConcurrency') expect(tenantId).toBe('');
					return values[key] ?? '';
				},
			},
		});
		expect(reader.workerConcurrency()).toBe(7);
		values.workerConcurrency = 9;
		expect(reader.workerConcurrency()).toBe(9);
		expect([...reader.providerHostAllowlist()]).toEqual(['live.example.com']);
		expect(reader.defaultMaxOutputTokens('tenant-a')).toBe(4_096);
		expect(reader.defaultModel('tenant-a')).toBe('');
	});
});
