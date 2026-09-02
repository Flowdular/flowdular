import { describe, expect, it } from 'vitest';
import { createPlatformAgentRegistry } from '../src/index.ts';

interface Definition {
	readonly id: string;
	readonly moduleId: string;
}

describe('platform agent registry', () => {
	it('seals definitions into one sorted immutable snapshot', () => {
		const registry = createPlatformAgentRegistry<Definition>();
		registry.register([
			{ id: 'module-agent:parties.core:matcher', moduleId: 'parties.core' },
		]);
		registry.register([
			{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
		]);

		registry.seal();
		const first = registry.list();
		const second = registry.list();

		expect(first.map((definition) => definition.id)).toEqual([
			'module-agent:catalog.core:curator',
			'module-agent:parties.core:matcher',
		]);
		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(() =>
			(first as Definition[]).push({
				id: 'module-agent:late.core:agent',
				moduleId: 'late.core',
			}),
		).toThrow();
	});

	it('rejects late registration without changing the sealed catalog', () => {
		const registry = createPlatformAgentRegistry<Definition>();
		registry.register([
			{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
		]);
		registry.seal();

		expect(() =>
			registry.register([
				{ id: 'module-agent:parties.core:matcher', moduleId: 'parties.core' },
			]),
		).toThrow(/already sealed/);
		expect(registry.list().map((definition) => definition.id)).toEqual([
			'module-agent:catalog.core:curator',
		]);
	});

	it('rejects a duplicate batch atomically', () => {
		const registry = createPlatformAgentRegistry<Definition>();
		registry.register([
			{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
		]);

		expect(() =>
			registry.register([
				{ id: 'module-agent:parties.core:matcher', moduleId: 'parties.core' },
				{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
			]),
		).toThrow(/already registered/);
		expect(registry.list().map((definition) => definition.id)).toEqual([
			'module-agent:catalog.core:curator',
		]);
	});

	it('rejects duplicates inside one batch and invalid runtime ids', () => {
		const registry = createPlatformAgentRegistry<Definition>();
		const duplicate = {
			id: 'module-agent:catalog.core:curator',
			moduleId: 'catalog.core',
		};
		expect(() => registry.register([duplicate, duplicate])).toThrow(
			/already registered/,
		);
		expect(() =>
			registry.register([{ id: '', moduleId: 'catalog.core' }]),
		).toThrow(/requires an id/);
		expect(registry.list()).toEqual([]);
	});

	it('binds registration ownership to the composing module', () => {
		const registry = createPlatformAgentRegistry<Definition>();
		const catalog = registry.forModule('catalog.core');
		catalog.register([
			{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
		]);

		expect(() =>
			catalog.register([
				{ id: 'module-agent:parties.core:matcher', moduleId: 'parties.core' },
			]),
		).toThrow(/cannot register an agent owned by parties\.core/);
		expect(() => catalog.forModule('parties.core')).toThrow(
			/cannot obtain the agent registrar/,
		);
		expect(registry.list()).toEqual([
			{ id: 'module-agent:catalog.core:curator', moduleId: 'catalog.core' },
		]);
	});
});
