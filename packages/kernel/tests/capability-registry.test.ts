import { describe, expect, it } from 'vitest';
import { createPlatformCapabilityRegistry } from '../src/capability-registry.ts';

describe('platform capability registry', () => {
	it('registers and resolves a typed module capability', () => {
		const registry = createPlatformCapabilityRegistry();
		const queue = { enqueue: () => 'run-1' };
		registry.register('agents.run-queue', queue);

		expect(registry.has('agents.run-queue')).toBe(true);
		expect(registry.get<typeof queue>('agents.run-queue')?.enqueue()).toBe(
			'run-1',
		);
		expect(registry.get('missing.capability')).toBeNull();
	});

	it('rejects invalid and duplicate identifiers', () => {
		const registry = createPlatformCapabilityRegistry();
		expect(() => registry.register('bad', {})).toThrow(/invalid id/);
		registry.register('agents.run-queue', {});
		expect(() => registry.register('agents.run-queue', {})).toThrow(
			/already registered/,
		);
	});
});
