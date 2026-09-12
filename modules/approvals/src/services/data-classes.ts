import type {
	DataClassDeclaration,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type {
	ApprovalDecision,
	ApprovalRequestDetail,
} from '../domain/types.ts';
import type { ApprovalsRepository } from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/**
 * Days a resolved request is kept, per D-APPROVALS-DATA-CLASSES. The period
 * covers the whole request: the request row, the eligibility snapshot taken
 * when it opened and every decision recorded on it. It is longer than a run's,
 * because a request is the record of who agreed to an action on a workspace's
 * records and is asked about long after the action itself.
 */
export const REQUEST_RETENTION_DAYS = 400;

/**
 * The class approvals.core owns.
 *
 * `requests` is what a workspace accumulates. Only a resolved request is
 * swept: a pending one is still asking, so no period makes it old enough to
 * take out from under the people who have to answer it. The export walks the
 * requests of one workspace by id and carries each one's ledger with it,
 * comments included, because the comment is the reason a person gave and the
 * archive is read by people the request was already visible to.
 *
 * An erasure removes the resolved requests the subject opened, with their
 * eligibility and decision rows. A decision the subject made in somebody
 * else's request is redacted instead of removed: the ledger is append-only and
 * a request that resolved on two approvals has to go on showing two. The rows
 * naming the subject in somebody else's eligibility snapshot are redacted the
 * same way, pending requests included, so no account of theirs is left in the
 * workspace while the people who can still answer keep their own rows. The
 * answer keeps the two apart: `removed` is what went, `redacted` is what
 * stayed without the subject in it.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function approvalsDataClasses(
	repository: () => Promise<ApprovalsRepository>,
	pageSize = EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'requests',
			label: 'Approval requests',
			defaultRetentionDays: REQUEST_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteResolvedBefore(tenantId, cutoff.getTime(), limit),
			}),
			erase: async ({ tenantId, subject, limit }) => {
				const store = await repository();
				const removed = await store.deleteResolvedRequestedBy(
					tenantId,
					subject.accountId,
					limit,
				);
				/* Only once the subject's own requests are exhausted, so what these
				   reach is somebody else's request: the subject never decides a
				   request they opened and is never in its eligibility snapshot. */
				let redacted = 0;
				if (removed + redacted < limit) {
					redacted += await store.redactDecisionsBy(
						tenantId,
						subject.accountId,
						limit - removed - redacted,
					);
				}
				if (removed + redacted < limit) {
					redacted += await store.redactEligibilityOf(
						tenantId,
						subject.accountId,
						limit - removed - redacted,
					);
				}
				/* A redacted row holds nothing of the subject any more, so it fills
				   the batch the same way a removed one does; it is answered apart
				   from the removals because the row is still there. */
				/* A full batch may have left more behind; the caller repeats and the
				   next batch answers zero. Over-reporting one repeat is cheaper than
				   reporting a subject as cleared while rows remain. */
				return {
					removed,
					...(redacted > 0 ? { redacted } : {}),
					...(removed + redacted === limit ? { truncated: true } : {}),
				};
			},
			/* Every request the account opened, in any state. The erasure removes
			   the resolved ones alone, so a subject still waiting on a decision is
			   counted here and not cleared by a pass. */
			count: async ({ tenantId, subject }) =>
				(await repository()).countRequestedBy(tenantId, subject.accountId),
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let after: string | null = null;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportRequestsPage(tenantId, after, pageSize);
					for (const detail of page) {
						const at = new Date(detail.request.createdAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						after = detail.request.id;
						rows += 1;
						await sink.write(requestRow(detail));
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
	];
}

/**
 * One request as the archive carries it. The fields are named one by one so a
 * column added to the request later has to be put here deliberately rather
 * than reaching the export because it exists.
 */
function requestRow({
	request,
	decisions,
}: ApprovalRequestDetail): Record<string, unknown> {
	return {
		id: request.id,
		tenantId: request.tenantId,
		subjectModule: request.subjectModule,
		subjectRef: request.subjectRef,
		permission: request.permission,
		action: request.action,
		title: request.title,
		summary: request.summary,
		requesterAccountId: request.requesterAccountId,
		requirement: request.requirement,
		decisionsNeeded: request.decisionsNeeded,
		status: request.status,
		expiresAt: new Date(request.expiresAt).toISOString(),
		resolvedAt:
			request.resolvedAt === null
				? null
				: new Date(request.resolvedAt).toISOString(),
		createdAt: new Date(request.createdAt).toISOString(),
		decisions: decisions.map(decisionRow),
	};
}

function decisionRow(decision: ApprovalDecision): Record<string, unknown> {
	return {
		id: decision.id,
		deciderAccountId: decision.deciderAccountId,
		decision: decision.decision,
		comment: decision.comment,
		decidedAt: new Date(decision.decidedAt).toISOString(),
	};
}
