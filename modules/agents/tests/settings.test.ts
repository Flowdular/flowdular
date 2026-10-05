import { describe, expect, it } from 'vitest';
import { agentRuntimeOptionsFromEnvironment } from '../src/server/runtime.ts';
import {
	AGENTS_MODULE_SETTINGS,
	agentSettings,
	agentsModuleSettingsFromEnvironment,
} from '../src/settings.ts';
import { workerFreshnessWindowMs } from '../src/services/worker-availability.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

describe('agents.core module settings', () => {
	it('declares a valid set of settings', async () => {
		expect(AGENTS_MODULE_SETTINGS.moduleId).toBe('agents.core');
		expect(Object.keys(AGENTS_MODULE_SETTINGS.settings).sort()).toEqual([
			'agentMonthlyCostCapUsd',
			'assistantEnabled',
			'defaultMaxOutputTokens',
			'defaultModel',
			'defaultProvider',
			'monthlyCostCapUsd',
			'providerHostAllowlist',
			'providerReadinessTtlMs',
			'typedDecisionsEnabled',
			'workerConcurrency',
			'workerFreshnessMs',
			'workerLeaseMs',
		]);
		for (const definition of Object.values(AGENTS_MODULE_SETTINGS.settings)) {
			expect(definition.label).toBeTruthy();
			expect(definition.description).toBeTruthy();
			expect(definition.labelKey).toMatch(/^agents\./);
			expect(definition.descriptionKey).toMatch(/^agents\./);
			for (const key of [definition.labelKey, definition.descriptionKey]) {
				const localKey = key!.slice('agents.'.length);
				expect(localKey in translationsEn).toBe(true);
				expect(localKey in translationsPl).toBe(true);
			}
		}
	});

	it('takes deployment defaults from the environment', async () => {
		const declaration = agentsModuleSettingsFromEnvironment({
			FD_AGENT_WORKER_CONCURRENCY: '4',
			FD_AGENT_PROVIDER_HOST_ALLOWLIST: 'models.example.com',
		});
		expect(declaration.settings.workerConcurrency?.defaultValue).toBe(4);
		expect(declaration.settings.providerHostAllowlist?.defaultValue).toBe(
			'models.example.com',
		);
		expect(declaration.settings.defaultMaxOutputTokens?.defaultValue).toBe(
			4_096,
		);
	});

	it('falls back to the environment without a settings runtime', async () => {
		const reader = agentSettings({
			environment: {
				FD_AGENT_WORKER_CONCURRENCY: '3',
				FD_AGENT_PROVIDER_HOST_ALLOWLIST: 'a.example.com, B.example.com',
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

	it('reads live values from a settings runtime and survives its failures', async () => {
		const values: Record<string, unknown> = {
			workerConcurrency: 7,
			providerHostAllowlist: 'live.example.com',
			defaultMaxOutputTokens: 'not-a-number',
		};
		const reader = agentSettings({
			environment: { FD_AGENT_WORKER_CONCURRENCY: '3' },
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

describe('agents.core worker freshness window', () => {
	it('AGENTS-WORKER-AVAILABILITY declares workerFreshnessMs as a platform setting of 120000 between 30000 and 86400000', () => {
		expect(AGENTS_MODULE_SETTINGS.settings.workerFreshnessMs).toMatchObject({
			type: 'number',
			scope: 'platform',
			defaultValue: 120_000,
			min: 30_000,
			max: 86_400_000,
		});
		expect(agentSettings({ environment: {} }).workerFreshnessMs()).toBe(
			120_000,
		);
		expect(
			agentSettings({
				environment: {},
				settings: {
					get: (tenantId: string, _moduleId: string, key: string) => {
						expect(tenantId).toBe('');
						return key === 'workerFreshnessMs' ? 600_000 : undefined;
					},
				},
			}).workerFreshnessMs(),
		).toBe(600_000);
	});

	it('AGENTS-WORKER-AVAILABILITY never lets the window fall below three drain intervals', () => {
		expect(workerFreshnessWindowMs(120_000, 30_000)).toBe(120_000);
		/* A 300000 ms lease drains every 150000 ms. */
		expect(workerFreshnessWindowMs(120_000, 300_000)).toBe(450_000);
		expect(workerFreshnessWindowMs(30_000, 30_000)).toBe(45_000);
		expect(workerFreshnessWindowMs(30_000, 1_000)).toBe(30_000);
	});
});

describe('agents.core runtime options', () => {
	it('reads FD_AGENT_WORKER_DRAIN_MS from 0 to 720000 and refuses anything else', () => {
		const drainMs = (value?: string) =>
			agentRuntimeOptionsFromEnvironment(
				value === undefined ? {} : { FD_AGENT_WORKER_DRAIN_MS: value },
			).workerDrainMs;
		expect(drainMs()).toBe(0);
		expect(drainMs('0')).toBe(0);
		expect(drainMs('120000')).toBe(120_000);
		expect(drainMs('720000')).toBe(720_000);
		for (const invalid of ['-1', '720001', '1.5', 'soon']) {
			expect(() => drainMs(invalid)).toThrow(
				'FD_AGENT_WORKER_DRAIN_MS must be an integer between 0 and 720000.',
			);
		}
	});
});
