import { AUDIT_ACTIONS } from '@flowdular/module-auth/server';
import { ACCESS_LIMITS, type AccessChangeCategory } from '../domain/types.ts';

/**
 * Which recorded action belongs to which kind of change. This map is the one
 * place access.core decides what counts as privileged: the diff reads the
 * categories that change who holds what, the activity report reads every key.
 * The action strings come from auth.core's own constants, so a renamed action
 * fails to compile here instead of silently dropping out of both reports.
 */
export const ACTION_CATEGORIES: Readonly<Record<string, AccessChangeCategory>> =
	Object.freeze({
		[AUDIT_ACTIONS.memberCreated]: 'membership',
		[AUDIT_ACTIONS.memberUpdated]: 'membership',
		[AUDIT_ACTIONS.memberStatus]: 'membership',
		[AUDIT_ACTIONS.memberProvisioned]: 'membership',
		[AUDIT_ACTIONS.memberRemoved]: 'membership',
		[AUDIT_ACTIONS.membershipStatus]: 'membership',
		[AUDIT_ACTIONS.invitationCreated]: 'membership',
		[AUDIT_ACTIONS.invitationAccepted]: 'membership',
		[AUDIT_ACTIONS.memberRole]: 'role',
		[AUDIT_ACTIONS.roleCreated]: 'role',
		[AUDIT_ACTIONS.roleUpdated]: 'role',
		[AUDIT_ACTIONS.roleDeleted]: 'role',
		[AUDIT_ACTIONS.memberScopes]: 'scope',
		[AUDIT_ACTIONS.tokenIssued]: 'token',
		[AUDIT_ACTIONS.tokenRevoked]: 'token',
		[AUDIT_ACTIONS.providerCreated]: 'provider',
		[AUDIT_ACTIONS.providerUpdated]: 'provider',
		[AUDIT_ACTIONS.providerStatusChanged]: 'provider',
		[AUDIT_ACTIONS.providerSecretRotated]: 'provider',
		[AUDIT_ACTIONS.providerDeleted]: 'provider',
		[AUDIT_ACTIONS.settingsUpdated]: 'settings',
		[AUDIT_ACTIONS.settingsFlagChanged]: 'settings',
		[AUDIT_ACTIONS.memberPasswordReset]: 'security',
		[AUDIT_ACTIONS.mfaReset]: 'security',
		[AUDIT_ACTIONS.tenantRenamed]: 'security',
		[AUDIT_ACTIONS.workspaceProvisioned]: 'security',
	});

/* What the diff answers: the changes that move access from one holder to
   another. A settings edit or a password reset is administrative activity but
   grants nobody anything, so it stays out of the diff and in the report. */
const DIFF_CATEGORIES: ReadonlySet<AccessChangeCategory> = new Set([
	'membership',
	'role',
	'scope',
	'token',
	'provider',
]);

export type AccessReportKind = 'diff' | 'activity';

/** O(1) per audit row, which is what keeps the bounded walk cheap. */
export function changeCategory(
	action: string,
	kind: AccessReportKind,
): AccessChangeCategory | null {
	const category = ACTION_CATEGORIES[action];
	if (category === undefined) return null;
	if (kind === 'activity') return category;
	return DIFF_CATEGORIES.has(category) ? category : null;
}

/* Metadata keys worth showing beside a change. Everything else recorded with
   an event stays out of the report: auth.core keeps credentials out of the
   trail, and a report that forwarded whatever it found would carry whatever a
   later action starts recording. */
const DETAIL_KEYS = ['role', 'key', 'label', 'status', 'scopes', 'cleared'];

/**
 * A bounded, readable summary of one event's metadata: at most one entry per
 * known key, each value clipped, a list reported by its length because a scope
 * list belongs on the review rather than in a change line.
 */
export function changeDetail(
	metadata: Readonly<Record<string, unknown>>,
): string | null {
	const parts: string[] = [];
	for (const key of DETAIL_KEYS) {
		const value = metadata[key];
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			parts.push(`${key}=${value.length}`);
			continue;
		}
		if (typeof value === 'object') continue;
		parts.push(`${key}=${String(value).slice(0, ACCESS_LIMITS.detailValue)}`);
	}
	return parts.length === 0 ? null : parts.join(', ');
}
