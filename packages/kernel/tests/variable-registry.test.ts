import { describe, expect, it } from 'vitest';
import { createPlatformCapabilityRegistry } from '../src/capability-registry.ts';
import {
	createPlatformVariableRegistry,
	platformVariableRegistry,
	VariableResolutionError,
} from '../src/variable-registry.ts';

function request(
	overrides: Partial<
		Parameters<ReturnType<typeof createPlatformVariableRegistry>['resolve']>[1]
	> = {},
) {
	return {
		tenantId: 'tenant-a',
		actor: { kind: 'user' as const, id: 'account-a', label: 'Account A' },
		permissionSnapshot: ['parties.records.read'],
		signal: new AbortController().signal,
		bindings: { partyId: 'party-a' },
		...overrides,
	};
}

describe('platform variable registry', () => {
	it('offers only definitions covered by the scope mask', () => {
		const registry = createPlatformVariableRegistry();
		registry.register({
			id: 'context',
			variables: [
				{ key: 'context.today', label: 'Today', kind: 'date' },
				{
					key: 'party.name',
					label: 'Party',
					kind: 'text',
					scope: 'parties.party.read',
				},
			],
		});

		expect(registry.list([]).map((variable) => variable.key)).toEqual([
			'context.today',
		]);
		expect(
			registry.list(['parties.party.read']).map((variable) => variable.key),
		).toEqual(['context.today', 'party.name']);
	});

	it('rejects duplicate keys before a source becomes visible', () => {
		const registry = createPlatformVariableRegistry();
		registry.register({
			id: 'first',
			variables: [{ key: 'context.today', label: 'Today', kind: 'date' }],
		});
		expect(() =>
			registry.register({
				id: 'second',
				variables: [{ key: 'context.today', label: 'Duplicate', kind: 'date' }],
			}),
		).toThrow(/already registered/);
	});

	it('rejects malformed and duplicate keys within one source', () => {
		const registry = createPlatformVariableRegistry();
		expect(() =>
			registry.register({
				id: 'invalid',
				variables: [{ key: 'Invalid', label: 'Invalid', kind: 'text' }],
			}),
		).toThrow(/invalid/);
		expect(() =>
			registry.register({
				id: 'duplicate',
				variables: [
					{ key: 'context.today', label: 'Today', kind: 'date' },
					{ key: 'context.today', label: 'Again', kind: 'date' },
				],
			}),
		).toThrow(/already registered/);
	});

	it('resolves a scoped source with explicit tenant and record bindings', async () => {
		const registry = createPlatformVariableRegistry();
		const seen: Array<{ tenantId: string; partyId: string }> = [];
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				requiredBindings: { 'party.name': ['partyId'] },
				resolve: async (context) => {
					seen.push({
						tenantId: context.tenantId,
						partyId: context.bindings.partyId!,
					});
					return { 'party.name': 'Acme' };
				},
			},
		);

		await expect(
			registry.resolve('Hello {{ party.name }}', request()),
		).resolves.toBe('Hello Acme');
		expect(seen).toEqual([{ tenantId: 'tenant-a', partyId: 'party-a' }]);
	});

	it('refuses an unscoped variable before its source runs', async () => {
		const registry = createPlatformVariableRegistry();
		let invoked = false;
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				resolve: async () => {
					invoked = true;
					return { 'party.name': 'Secret party' };
				},
			},
		);

		await expect(
			registry.resolve('{{ party.name }}', request({ permissionSnapshot: [] })),
		).rejects.toMatchObject({ code: 'FORBIDDEN_TEMPLATE_VARIABLE' });
		expect(invoked).toBe(false);
	});

	it('never lets caller values spoof a key owned by a resolver', async () => {
		const registry = createPlatformVariableRegistry();
		let invoked = false;
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				resolve: async () => {
					invoked = true;
					return { 'party.name': 'Trusted party' };
				},
			},
		);

		await expect(
			registry.resolve(
				'{{ party.name }}',
				request({ values: { 'party.name': 'Spoofed party' } }),
			),
		).resolves.toBe('Trusted party');
		expect(invoked).toBe(true);
	});

	it('requires every declared binding before source invocation', async () => {
		const registry = createPlatformVariableRegistry();
		let invoked = false;
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				requiredBindings: { 'party.name': ['partyId'] },
				resolve: async () => {
					invoked = true;
					return { 'party.name': 'Acme' };
				},
			},
		);

		await expect(
			registry.resolve('{{ party.name }}', request({ bindings: {} })),
		).rejects.toMatchObject({ code: 'MISSING_VARIABLE_BINDING' });
		expect(invoked).toBe(false);
	});

	it('redacts source failures and never exposes their details', async () => {
		const registry = createPlatformVariableRegistry();
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				resolve: async () => {
					throw new Error('database-password=never-return-this');
				},
			},
		);

		let failure: unknown;
		try {
			await registry.resolve('{{ party.name }}', request());
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(VariableResolutionError);
		expect(failure).toMatchObject({ code: 'VARIABLE_SOURCE_FAILED' });
		expect(String(failure)).not.toContain('database-password');
	});

	it('redacts source-owned resolution errors and observes cancellation', async () => {
		const registry = createPlatformVariableRegistry();
		registry.register(
			{
				id: 'parties.records',
				variables: [
					{
						key: 'party.name',
						label: 'Party name',
						kind: 'text',
						scope: 'parties.records.read',
					},
				],
			},
			{
				resolve: async () => {
					throw new VariableResolutionError(
						'VARIABLE_VALUE_UNAVAILABLE',
						'Secret party 123 is unavailable.',
					);
				},
			},
		);
		await expect(
			registry.resolve('{{ party.name }}', request()),
		).rejects.toMatchObject({
			code: 'VARIABLE_VALUE_UNAVAILABLE',
			message: 'A variable value is unavailable.',
		});

		const controller = new AbortController();
		controller.abort('test');
		await expect(
			registry.resolve(
				'{{ party.name }}',
				request({ signal: controller.signal }),
			),
		).rejects.toMatchObject({ code: 'VARIABLE_RESOLUTION_ABORTED' });
	});

	it('shares one registry through the platform capability boundary', () => {
		const capabilities = createPlatformCapabilityRegistry();
		const first = platformVariableRegistry(capabilities);
		const second = platformVariableRegistry(capabilities);
		expect(second).toBe(first);
	});
});
