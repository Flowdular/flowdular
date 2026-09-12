import { activeLocale, t } from '@flowdular/client';
import type {
	ApprovalDecisionKind,
	ApprovalRequirementRecord,
	ApprovalStatus,
} from '../domain/types.ts';

export function statusLabel(status: ApprovalStatus): string {
	return t('approvals.status.' + status);
}

export function statusTone(
	status: ApprovalStatus,
): 'info' | 'success' | 'danger' | 'neutral' {
	if (status === 'pending') return 'info';
	if (status === 'approved') return 'success';
	if (status === 'rejected' || status === 'expired') return 'danger';
	return 'neutral';
}

export function decisionLabel(decision: ApprovalDecisionKind): string {
	return t('approvals.decision.' + decision);
}

/** Epoch milliseconds as the reader's locale writes them; empty stays empty. */
export function timestampLabel(value: number | null): string {
	if (value === null) return t('approvals.common.notYet');
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value));
}

/** The requirement as one line: who has to answer, how many of them, how long. */
export function requirementLabel(
	requirement: ApprovalRequirementRecord,
): string {
	const who =
		requirement.roleKey !== null && requirement.scope !== null
			? t('approvals.requirement.roleAndScope', {
					role: requirement.roleKey,
					scope: requirement.scope,
				})
			: requirement.roleKey !== null
				? t('approvals.requirement.role', { role: requirement.roleKey })
				: t('approvals.requirement.scope', { scope: requirement.scope ?? '' });
	return t('approvals.requirement.summary', {
		who,
		decisions: requirement.decisions,
		days: requirement.expiresInDays,
	});
}
