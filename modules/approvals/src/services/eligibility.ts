import type { ApprovalRequirement } from '@flowdular/kernel';
import { APPROVAL_LIMITS } from '../domain/capability.ts';
import type {
	ApprovalMember,
	ApprovalRequirementRecord,
} from '../domain/types.ts';
import {
	ApprovalsServiceError,
	bounded,
	boundedInteger,
} from './service-error.ts';

/**
 * The kernel requirement with both optional numbers resolved, so a stored row
 * never has to be read back through a partially specified shape. A requirement
 * naming neither a role nor a scope has no answer to who may decide, which is a
 * rejection rather than a request nobody can resolve.
 */
export function normalizeRequirement(
	requirement: ApprovalRequirement,
	defaultExpiryDays: number,
): ApprovalRequirementRecord {
	const roleKey =
		requirement.roleKey === undefined || requirement.roleKey === ''
			? null
			: bounded(requirement.roleKey, 'requirement.roleKey', 1, 64);
	const scope =
		requirement.scope === undefined || requirement.scope === ''
			? null
			: bounded(requirement.scope, 'requirement.scope', 1, 96);
	if (roleKey === null && scope === null) {
		throw new ApprovalsServiceError(
			'APPROVAL_REQUIREMENT_INVALID',
			'A requirement must name a role key or a scope.',
		);
	}
	return {
		roleKey,
		scope,
		decisions: boundedInteger(
			requirement.decisions ?? 1,
			'requirement.decisions',
			1,
			APPROVAL_LIMITS.decisions,
		),
		expiresInDays: boundedInteger(
			requirement.expiresInDays ?? defaultExpiryDays,
			'requirement.expiresInDays',
			1,
			APPROVAL_LIMITS.expiryDays,
		),
	};
}

/**
 * Whether one member satisfies the requirement now. A requirement that names
 * both a role and a scope asks for both: the narrower reading is the one that
 * cannot widen who decides. The requester never decides their own request.
 */
export function memberSatisfies(
	requirement: ApprovalRequirementRecord,
	member: ApprovalMember,
	requesterAccountId: string,
): boolean {
	if (member.accountId === requesterAccountId) return false;
	if (requirement.roleKey !== null && member.roleKey !== requirement.roleKey) {
		return false;
	}
	if (
		requirement.scope !== null &&
		!member.scopes.includes(requirement.scope)
	) {
		return false;
	}
	return true;
}

/**
 * The snapshot taken when the request opens. It is what a screen shows and what
 * the inbox filters on; a decision is checked again against live membership, so
 * a member who lost the role after the request cannot decide even though the
 * snapshot still names them.
 */
export function resolveEligible(
	requirement: ApprovalRequirementRecord,
	members: readonly ApprovalMember[],
	requesterAccountId: string,
): readonly string[] {
	const eligible = members
		.filter((member) =>
			memberSatisfies(requirement, member, requesterAccountId),
		)
		.map((member) => member.accountId)
		.sort();
	const unique = [...new Set(eligible)];
	if (unique.length === 0) {
		throw new ApprovalsServiceError(
			'APPROVAL_NO_ELIGIBLE_DECIDER',
			'No member of this workspace satisfies the requirement.',
			409,
		);
	}
	if (unique.length < requirement.decisions) {
		throw new ApprovalsServiceError(
			'APPROVAL_ELIGIBLE_INSUFFICIENT',
			`The requirement needs ${requirement.decisions} decisions and ${unique.length} members can give one.`,
			409,
		);
	}
	/* The snapshot decides whose inbox the request appears in, so truncating it
	   would hide the request from a member who may decide. A requirement this
	   wide is refused instead. */
	if (unique.length > APPROVAL_LIMITS.eligible) {
		throw new ApprovalsServiceError(
			'APPROVAL_ELIGIBLE_TOO_MANY',
			`A requirement may name at most ${APPROVAL_LIMITS.eligible} deciders.`,
			409,
		);
	}
	return unique;
}
