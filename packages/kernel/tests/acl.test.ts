import { describe, expect, it } from 'vitest';
import {
	authorize,
	authorizeRecord,
	createPolicyRegistry,
	definePolicy,
	MAX_POLICIES,
	type Principal,
} from '../src/index.ts';

interface Claim {
	readonly amountMinor: number;
}

const approver: Principal = {
	id: 'account-1',
	permissions: new Set(['expenses.claims.approve']),
};

const amountLimit = definePolicy<Claim>({
	id: 'expenses.claims.amount-limit',
	permission: 'expenses.claims.approve',
	evaluate: ({ record }) =>
		record.amountMinor <= 100_000
			? { allowed: true }
			: {
					allowed: false,
					reason: 'The claim exceeds the approver limit.',
					requiresApproval: {
						requirement: { roleKey: 'finance-lead', decisions: 2 },
					},
				},
});

describe('permission scope', () => {
	it('grants a held permission and names why it refuses', () => {
		expect(authorize(approver, 'expenses.claims.approve')).toEqual({
			allowed: true,
			reason: 'granted',
		});
		expect(authorize(null, 'expenses.claims.approve').reason).toBe('anonymous');
		expect(authorize(approver, 'expenses.claims.delete').reason).toBe(
			'missing-permission',
		);
	});
});

describe('policy registry', () => {
	it('allows a record no policy refuses', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);

		expect(
			registry.evaluate(approver, 'expenses.claims.approve', {
				amountMinor: 100_000,
			}),
		).toEqual({ allowed: true });
	});

	it('returns the denial with its reason and approval requirement', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);

		expect(
			registry.evaluate(approver, 'expenses.claims.approve', {
				amountMinor: 250_000,
			}),
		).toEqual({
			allowed: false,
			reason: 'The claim exceeds the approver limit.',
			requiresApproval: {
				requirement: { roleKey: 'finance-lead', decisions: 2 },
			},
		});
	});

	it('evaluates in registration order and stops at the first denial', () => {
		const evaluated: string[] = [];
		const trace = (id: string, allowed: boolean) =>
			definePolicy({
				id,
				permission: 'expenses.claims.approve',
				evaluate: () => {
					evaluated.push(id);
					return allowed
						? { allowed: true }
						: { allowed: false, reason: `${id} refused` };
				},
			});
		const registry = createPolicyRegistry();
		registry.register(trace('expenses.claims.first', true));
		registry.register(trace('expenses.claims.second', false));
		registry.register(trace('expenses.claims.third', false));

		const decision = registry.evaluate(
			approver,
			'expenses.claims.approve',
			null,
		);

		expect(decision).toEqual({
			allowed: false,
			reason: 'expenses.claims.second refused',
		});
		expect(evaluated).toEqual([
			'expenses.claims.first',
			'expenses.claims.second',
		]);
		expect(
			registry.list('expenses.claims.approve').map((policy) => policy.id),
		).toEqual([
			'expenses.claims.first',
			'expenses.claims.second',
			'expenses.claims.third',
		]);
	});

	it('carries the action and the principal into the policy', () => {
		const seen: {
			action?: string | undefined;
			principalId?: string | undefined;
		} = {};
		const registry = createPolicyRegistry();
		registry.register(
			definePolicy({
				id: 'expenses.claims.self-approval',
				permission: 'expenses.claims.approve',
				evaluate: (context) => {
					seen.action = context.action;
					seen.principalId = context.principal.id;
					return { allowed: true };
				},
			}),
		);

		registry.evaluate(approver, 'expenses.claims.approve', null, 'submit');
		expect(seen).toEqual({ action: 'submit', principalId: 'account-1' });

		registry.evaluate(approver, 'expenses.claims.approve', null);
		expect(seen.action).toBeUndefined();
	});

	it('has no policies for a permission nobody qualified', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);

		expect(registry.list('expenses.claims.delete')).toEqual([]);
		expect(
			registry.evaluate(approver, 'expenses.claims.delete', {
				amountMinor: 900_000,
			}),
		).toEqual({ allowed: true });
	});

	it('refuses a duplicate id without replacing the registered policy', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);

		expect(() =>
			registry.register(
				definePolicy({
					id: 'expenses.claims.amount-limit',
					permission: 'expenses.claims.approve',
					evaluate: () => ({ allowed: true }),
				}),
			),
		).toThrow(/already registered/);
		expect(registry.list('expenses.claims.approve')).toEqual([amountLimit]);
	});

	it('refuses an invalid policy definition before it can be registered', () => {
		expect(() =>
			definePolicy({
				id: 'AmountLimit',
				permission: 'expenses.claims.approve',
				evaluate: () => ({ allowed: true }),
			}),
		).toThrow(/invalid id/);
		expect(() =>
			definePolicy({
				id: 'expenses.claims.amount-limit',
				permission: 'approve',
				evaluate: () => ({ allowed: true }),
			}),
		).toThrow(/invalid permission/);
	});

	it('bounds the catalog', () => {
		const registry = createPolicyRegistry();
		for (let index = 0; index < MAX_POLICIES; index += 1) {
			registry.register(
				definePolicy({
					id: `expenses.claims.rule-${index}`,
					permission: 'expenses.claims.approve',
					evaluate: () => ({ allowed: true }),
				}),
			);
		}

		expect(() =>
			registry.register(
				definePolicy({
					id: 'expenses.claims.rule-over',
					permission: 'expenses.claims.approve',
					evaluate: () => ({ allowed: true }),
				}),
			),
		).toThrow(/at most 256 policies/);
		expect(registry.list('expenses.claims.approve')).toHaveLength(MAX_POLICIES);
	});

	it('refuses registration once the platform has started', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);
		registry.seal();

		expect(() =>
			registry.register(
				definePolicy({
					id: 'expenses.claims.late',
					permission: 'expenses.claims.approve',
					evaluate: () => ({ allowed: false, reason: 'late' }),
				}),
			),
		).toThrow(/already sealed/);
		expect(
			registry.evaluate(approver, 'expenses.claims.approve', {
				amountMinor: 1,
			}),
		).toEqual({ allowed: true });
	});

	it('denies when a policy throws instead of letting the failure escape', () => {
		const registry = createPolicyRegistry();
		registry.register(
			definePolicy({
				id: 'expenses.claims.broken',
				permission: 'expenses.claims.approve',
				evaluate: () => {
					throw new Error('provider token sk-secret-value');
				},
			}),
		);

		expect(
			registry.evaluate(approver, 'expenses.claims.approve', null),
		).toEqual({
			allowed: false,
			reason: 'policy-failed:expenses.claims.broken',
		});
	});
});

describe('authorizeRecord', () => {
	it('checks the scope before any policy runs', () => {
		const registry = createPolicyRegistry();
		let evaluations = 0;
		registry.register(
			definePolicy({
				id: 'expenses.claims.counted',
				permission: 'expenses.claims.approve',
				evaluate: () => {
					evaluations += 1;
					return { allowed: true };
				},
			}),
		);

		expect(
			authorizeRecord(registry, null, 'expenses.claims.approve', null),
		).toEqual({ allowed: false, reason: 'anonymous' });
		expect(
			authorizeRecord(
				registry,
				{ id: 'account-2', permissions: new Set() },
				'expenses.claims.approve',
				null,
			),
		).toEqual({ allowed: false, reason: 'missing-permission' });
		expect(evaluations).toBe(0);

		expect(
			authorizeRecord(registry, approver, 'expenses.claims.approve', null),
		).toEqual({ allowed: true });
		expect(evaluations).toBe(1);
	});

	it('answers the policy decision once the scope holds', () => {
		const registry = createPolicyRegistry();
		registry.register(amountLimit);

		expect(
			authorizeRecord(registry, approver, 'expenses.claims.approve', {
				amountMinor: 250_000,
			}),
		).toMatchObject({
			allowed: false,
			requiresApproval: { requirement: { roleKey: 'finance-lead' } },
		});
	});
});
