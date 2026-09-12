import { describe, expect, it } from 'vitest';
import { REPORT_PROVIDER_LIMITS } from '../src/domain/providers.ts';
import { createReportProviderRegistry } from '../src/services/provider-registry.ts';
import { ReportsServiceError } from '../src/services/service-error.ts';
import { fakeProvider } from './support/harness.ts';

const READ = 'metering.usage.read';

function code(run: () => void): string {
	try {
		run();
	} catch (error) {
		return error instanceof ReportsServiceError ? error.code : 'NOT_SERVICE';
	}
	return 'NO_ERROR';
}

describe('REPORTS-BOUNDS registry', () => {
	it('refuses the provider past the deployment bound and keeps the rest', () => {
		const registry = createReportProviderRegistry();
		for (let index = 0; index < REPORT_PROVIDER_LIMITS.providers; index += 1) {
			registry.register('metering.core', [
				fakeProvider({ key: `metering.usage-${index}`, permission: READ }),
			]);
		}
		expect(
			code(() =>
				registry.register('agents.core', [
					fakeProvider({ key: 'agents.runs', permission: READ }),
				]),
			),
		).toBe('PROVIDER_LIMIT_EXCEEDED');
		expect(registry.list()).toHaveLength(REPORT_PROVIDER_LIMITS.providers);
	});

	it('refuses a duplicate key without registering anything of that batch', () => {
		const registry = createReportProviderRegistry();
		registry.register('metering.core', [
			fakeProvider({ key: 'metering.usage', permission: READ }),
		]);
		expect(
			code(() =>
				registry.register('agents.core', [
					fakeProvider({ key: 'agents.runs', permission: READ }),
					fakeProvider({ key: 'metering.usage', permission: READ }),
				]),
			),
		).toBe('PROVIDER_DUPLICATE');
		expect(registry.list().map((entry) => entry.key)).toEqual([
			'metering.usage',
		]);
	});

	it('refuses a malformed provider', () => {
		const registry = createReportProviderRegistry();
		expect(
			code(() =>
				registry.register('metering.core', [
					{ key: 'Metering Usage', label: 'x', permission: READ } as never,
				]),
			),
		).toBe('PROVIDER_INVALID');
		expect(
			code(() =>
				registry.register('metering.core', [
					{ key: 'metering.usage', label: 'x', permission: READ } as never,
				]),
			),
		).toBe('PROVIDER_INVALID');
		expect(code(() => registry.register('metering', []))).toBe(
			'PROVIDER_INVALID',
		);
		expect(registry.list()).toHaveLength(0);
	});
});

describe('REPORTS-SEALED', () => {
	it('refuses a registration after reports.core started and keeps the list', () => {
		const registry = createReportProviderRegistry();
		registry.register('metering.core', [
			fakeProvider({ key: 'metering.usage', permission: READ }),
		]);
		registry.seal();
		expect(
			code(() =>
				registry.register('agents.core', [
					fakeProvider({ key: 'agents.runs', permission: READ }),
				]),
			),
		).toBe('PROVIDER_REGISTRY_SEALED');
		expect(registry.list().map((entry) => entry.key)).toEqual([
			'metering.usage',
		]);
	});

	/* Sealing twice is a platform restart hazard, not a module error: the list
	   a request reads must stay the one the first seal froze. */
	it('keeps the frozen list when sealed again', () => {
		const registry = createReportProviderRegistry();
		registry.register('metering.core', [
			fakeProvider({ key: 'metering.usage', permission: READ }),
		]);
		registry.seal();
		const frozen = registry.list();
		registry.seal();
		expect(registry.list()).toBe(frozen);
	});
});
