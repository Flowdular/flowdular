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
});
