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

	it('preserves an explicit versioned workflow action contract', () => {
		const tool = defineApiAgentTool({
			id: 'parties.customer.lookup',
			endpointId: 'parties.records.get',
			description: 'Read one tenant customer.',
			requiredPermissions: ['parties.records.read'],
			inputSchema: { type: 'object' },
			contractVersion: 2,
			outputSchema: { type: 'object' },
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			execute: async () => ({}),
		});
		expect(tool).toMatchObject({
			contractVersion: 2,
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			outputSchema: { type: 'object' },
		});
	});

	/* The harness admits it only under an approval grant; building it is not
	   the gate. */
	it('builds a destructive CLI capability the harness gates per call', () => {
		const tool = defineCliAgentTool({
			id: 'auth.local.reset',
			capability: {
				id: 'auth.greenfield.reset',
				risk: 'destructive',
				localOnly: true,
			},
			description: 'Reset local authentication data.',
			requiredPermissions: [],
			risk: 'destructive',
			execute: async () => undefined,
		});
		expect(tool).toMatchObject({
			transport: 'cli',
			risk: 'destructive',
			localOnly: true,
		});
	});
});
