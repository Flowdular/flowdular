import { describe, expect, it } from 'vitest';
import { defineApiAgentTool, defineCliAgentTool } from '../src/index.ts';

describe('agent tool adapters', () => {
	it('records the approved API endpoint as the tool target', () => {
		const tool = defineApiAgentTool({
			id: 'parties.customer.read',
			endpointId: 'parties.records.list',
			description: 'Read tenant parties.',
			requiredPermissions: ['parties.records.read'],
			execute: async () => [],
		});
		expect(tool).toMatchObject({
			transport: 'api',
			target: 'parties.records.list',
		});
	});

	it('rejects unattended destructive CLI capabilities', () => {
		expect(() =>
			defineCliAgentTool({
				id: 'auth.local.reset',
				capability: { id: 'auth.greenfield.reset', risk: 'destructive' },
				description: 'Reset local authentication data.',
				requiredPermissions: [],
				execute: async () => undefined,
			}),
		).toThrow('approval receipt');
	});
});
