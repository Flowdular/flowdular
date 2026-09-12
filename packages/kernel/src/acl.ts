import { RegistryError } from './errors.ts';

export interface Principal {
	readonly id: string;
	readonly permissions: ReadonlySet<string>;
}

export interface AccessDecision {
	readonly allowed: boolean;
	readonly reason: 'granted' | 'anonymous' | 'missing-permission';
}

export function authorize(
	principal: Principal | null,
	permission: string,
): AccessDecision {
	if (!principal) return { allowed: false, reason: 'anonymous' };
	if (!principal.permissions.has(permission)) {
		return { allowed: false, reason: 'missing-permission' };
	}
	return { allowed: true, reason: 'granted' };
}

/* What a denied decision would need to become an allow. The kernel owns the
   shape only: resolving a role or a scope to people, collecting their decisions
   and recording the receipt belong to the module that owns approvals. */
export interface ApprovalRequirement {
	readonly roleKey?: string;
	readonly scope?: string;
	readonly decisions?: number;
	readonly expiresInDays?: number;
}

export type PolicyDecision =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: string;
			readonly requiresApproval?: {
				readonly requirement: ApprovalRequirement;
			};
	  };

export interface PolicyEvaluationContext<TRecord = unknown> {
	readonly principal: Principal;
	readonly permission: string;
	readonly record: TRecord;
	/** The domain operation, when one permission covers several. */
	readonly action?: string;
}

export interface PolicyDefinition<TRecord = unknown> {
	readonly id: string;
	readonly permission: string;
	evaluate(context: PolicyEvaluationContext<TRecord>): PolicyDecision;
}

/** A registered policy: the record is the permission's, so the registry keeps none. */
export type Policy = PolicyDefinition<unknown>;

export const MAX_POLICIES = 256;

/* Permission ids and policy ids share one shape, so a policy id reads as
   `<module>.<record>.<rule>` next to the permission it qualifies. */
const POLICY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const ALLOWED: PolicyDecision = Object.freeze({ allowed: true });
const NO_POLICIES: readonly Policy[] = Object.freeze([]);

export function definePolicy<TRecord = unknown>(
	definition: PolicyDefinition<TRecord>,
): Policy {
	if (!POLICY_ID.test(definition.id)) {
		throw new RegistryError(
			'POLICY_INVALID',
			`Policy ${definition.id} has an invalid id.`,
		);
	}
	if (!POLICY_ID.test(definition.permission)) {
		throw new RegistryError(
			'POLICY_INVALID',
			`Policy ${definition.id} names an invalid permission ${definition.permission}.`,
		);
	}
	if (typeof definition.evaluate !== 'function') {
		throw new RegistryError(
			'POLICY_INVALID',
			`Policy ${definition.id} has no evaluate function.`,
		);
	}
	/* The record type belongs to the permission, not to the registry, which
	   holds policies of every module at once. This is the one place the author's
	   record type is erased, so a policy body stays typed. */
	return Object.freeze({
		id: definition.id,
		permission: definition.permission,
		evaluate: definition.evaluate as Policy['evaluate'],
	});
}

export interface PolicyRegistry {
	register(policy: Policy): void;
	/** Registration order, which is evaluation order. Empty for an unknown permission. */
	list(permission: string): readonly Policy[];
	evaluate(
		principal: Principal,
		permission: string,
		record: unknown,
		action?: string,
	): PolicyDecision;
}

export interface MutablePolicyRegistry extends PolicyRegistry {
	seal(): void;
}

/* Policies are registered while the platform composes and become an immutable
   catalog before start hooks run: a policy registered at request time would
   change an authorization decision under the requests already in flight. */
export function createPolicyRegistry(): MutablePolicyRegistry {
	const ids = new Set<string>();
	const byPermission = new Map<string, Policy[]>();
	let sealed = false;
	return {
		register(policy) {
			if (sealed) {
				throw new RegistryError(
					'POLICY_REGISTRY_SEALED',
					'The policy registry is already sealed.',
				);
			}
			if (ids.has(policy.id)) {
				throw new RegistryError(
					'POLICY_DUPLICATE',
					`Policy ${policy.id} is already registered.`,
				);
			}
			if (ids.size >= MAX_POLICIES) {
				throw new RegistryError(
					'POLICY_LIMIT',
					`A platform registers at most ${MAX_POLICIES} policies.`,
				);
			}
			ids.add(policy.id);
			const registered = byPermission.get(policy.permission);
			if (registered) registered.push(policy);
			else byPermission.set(policy.permission, [policy]);
		},
		list(permission) {
			const registered = byPermission.get(permission);
			if (registered === undefined) return NO_POLICIES;
			return Object.freeze([...registered]);
		},
		evaluate(principal, permission, record, action) {
			const registered = byPermission.get(permission);
			if (registered === undefined) return ALLOWED;
			const context: PolicyEvaluationContext =
				action === undefined
					? { principal, permission, record }
					: { principal, permission, record, action };
			for (const policy of registered) {
				const decision = evaluatePolicy(policy, context);
				if (!decision.allowed) return decision;
			}
			return ALLOWED;
		},
		seal() {
			sealed = true;
		},
	};
}

/* A policy is module code on the authorization path. A throwing policy denies
   instead of escaping, so one faulty policy can never turn into an allow. */
function evaluatePolicy(
	policy: Policy,
	context: PolicyEvaluationContext,
): PolicyDecision {
	try {
		return policy.evaluate(context);
	} catch {
		return { allowed: false, reason: `policy-failed:${policy.id}` };
	}
}

/** The permission scope first, then the policies that qualify it. */
export function authorizeRecord(
	registry: PolicyRegistry,
	principal: Principal | null,
	permission: string,
	record: unknown,
	action?: string,
): PolicyDecision {
	const scope = authorize(principal, permission);
	if (!scope.allowed || !principal) {
		return { allowed: false, reason: scope.reason };
	}
	return registry.evaluate(principal, permission, record, action);
}
