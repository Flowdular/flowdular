import { describe, expect, it } from 'vitest';
import { createPlatformToolRegistry } from '../src/index.ts';

describe('platform tool registry', () => {
	it('collects tools from several modules and rejects duplicate ids', () => {
		const registry = createPlatformToolRegistry<{
			readonly id: string;
			readonly module: string;
		}>();
		registry.register([{ id: 'catalog.items.search', module: 'catalog.core' }]);
		registry.register([{ id: 'parties.lookup', module: 'parties.core' }]);
		expect(registry.list().map((tool) => tool.id)).toEqual([
			'catalog.items.search',
			'parties.lookup',
		]);
		expect(() =>
			registry.register([{ id: 'parties.lookup', module: 'other.core' }]),
		).toThrow(/already registered/);
	});

	it('keeps native tools apart from invocable tools in one id space', () => {
		const registry = createPlatformToolRegistry<
			{ readonly id: string },
			{ readonly id: string; readonly kind: 'web-search' }
		>();
		registry.register([{ id: 'research.search' }]);
		registry.registerNative({ id: 'research.web-search', kind: 'web-search' });
		expect(registry.list().map((tool) => tool.id)).toEqual(['research.search']);
		expect(registry.listNative()).toEqual([
			{ id: 'research.web-search', kind: 'web-search' },
		]);
		expect(() =>
			registry.registerNative({ id: 'research.search', kind: 'web-search' }),
		).toThrow(/already registered/);
		expect(() => registry.register([{ id: 'research.web-search' }])).toThrow(
			/already registered/,
		);
	});
});
