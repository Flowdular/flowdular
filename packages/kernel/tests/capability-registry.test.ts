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

describe('module-scoped capability registry', () => {
	it('enforces provides on register and requires on get and has', () => {
		const root = createPlatformCapabilityRegistry();
		const agents = root.forModule('agents.core', {
			provides: ['agents.run-queue'],
			requires: [{ id: 'notifications.publish.v1', optional: true }],
		});
		agents.register('agents.run-queue', { enqueue: () => 'run-1' });
		expect(() => agents.register('agents.actions.v1', {})).toThrow(
			/without declaring it under "provides"/,
		);
		expect(agents.get('notifications.publish.v1')).toBeNull();
		expect(agents.has('agents.run-queue')).toBe(true);
		expect(() => agents.get('workflows.execution.v1')).toThrow(
			/without declaring it under "requires"/,
		);
		expect(() => agents.has('workflows.execution.v1')).toThrow(
			/without declaring it under "requires"/,
		);

		const automations = root.forModule('automations.core', {
			requires: [{ id: 'agents.run-queue' }],
		});
		expect(
			automations.get<{ enqueue: () => string }>('agents.run-queue')?.enqueue(),
		).toBe('run-1');
	});

	it('keeps kernel-owned platform capabilities open to every module', () => {
		const root = createPlatformCapabilityRegistry();
		const scoped = root.forModule('sample.core', {});
		expect(scoped.get('platform.variables')).toBeNull();
		scoped.register('platform.variables', { sources: [] });
		expect(root.has('platform.variables')).toBe(true);
	});
});
