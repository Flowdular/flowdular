import type {
	DataClassDeclaration,
	DataClassErasureResult,
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { AuthRepository } from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const AUTH_EXPORT_PAGE = 500;

/**
 * Rows one sweep call may remove, whatever the caller asks for. It is the
 * ceiling of the audit.core `sweepBatchSize` setting (modules/audit/src/
 * settings.ts, max 5_000): auth.core must never depend on audit.core, so the
 * number is repeated here rather than imported, and raising that maximum
 * without raising this one silently caps every auth sweep batch.
 */
export const AUTH_SWEEP_LIMIT = 5_000;

/** Rows one erasure call may remove, whatever the caller asks for. */
export const AUTH_ERASE_LIMIT = 5_000;

/**
 * Days an expired session row is kept. The row is already dead at its expiry,
 * so this period only bounds how long the workspace keeps the record of a
 * sign-in that ended.
 */
export const SESSION_RETENTION_DAYS = 30;

/**
 * Days a retired credential and an authentication audit row are kept. Thirteen
 * months covers a yearly review plus the overlap a workspace needs to compare
 * it against the previous one.
 */
export const SECURITY_RETENTION_DAYS = 400;

/**
 * What auth.core holds per workspace and keeps by age. Memberships, membership
 * scopes, roles, identity providers and module settings are configuration a
 * person maintains, not history, so they are not swept classes; invitations,
 * password reset tokens and MFA challenges are short-lived credentials their
 * own paths consume or expire.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function authDataClasses(
	repository: () => Promise<AuthRepository>,
	pageSize = AUTH_EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'sessions',
			label: 'Sessions',
			defaultRetentionDays: SESSION_RETENTION_DAYS,
			exportable: true,
			/* Only a session that has already expired is removed here. The runtime
			   also drops expired rows on its own interval; both delete the same
			   dead rows, and neither can reach a live session. */
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteSessionsExpiredBefore(tenantId, cutoff.getTime(), batch(limit)),
			}),
			/* Every session of the subject in this workspace, live ones included:
			   an erased subject keeps no way into it. Sessions the same account
			   holds in another workspace are another workspace's rows. */
			erase: ({ tenantId, subject, limit }) =>
				eraseSubject(limit, async (size) =>
					(await repository()).deleteMembershipSessionsOf(
						tenantId,
						subject.accountId,
						size,
					),
				),
			export: ({ tenantId, sink }) =>
				walk(sink, pageSize, '', async (after, size) =>
					(await repository())
						.exportSessionsPage(tenantId, after, size)
						.then((page) =>
							page.map((session) => ({
								cursor: session.id,
								at: session.createdAt,
								row: {
									...session,
									createdAt: new Date(session.createdAt).toISOString(),
									expiresAt: new Date(session.expiresAt).toISOString(),
									lastSeenAt: new Date(session.lastSeenAt).toISOString(),
								},
							})),
						),
				),
		},
		{
			key: 'api-tokens',
			label: 'API tokens',
			defaultRetentionDays: SECURITY_RETENTION_DAYS,
			exportable: true,
			/* A token that is neither revoked nor expired authenticates requests
			   and is never removed by age. */
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteApiTokensRetiredBefore(
					tenantId,
					cutoff.getTime(),
					batch(limit),
				),
			}),
			/* A token the subject holds in this workspace is removed outright
			   rather than revoked: a revoked row still names the person. */
			erase: ({ tenantId, subject, limit }) =>
				eraseSubject(limit, async (size) =>
					(await repository()).deleteMembershipApiTokensOf(
						tenantId,
						subject.accountId,
						size,
					),
				),
			export: ({ tenantId, sink }) =>
				walk(sink, pageSize, '', async (after, size) =>
					(await repository())
						.exportApiTokensPage(tenantId, after, size)
						.then((page) =>
							page.map((token) => ({
								cursor: token.id,
								at: token.createdAt,
								row: {
									...token,
									scopes: [...token.scopes],
									createdAt: new Date(token.createdAt).toISOString(),
									expiresAt: instant(token.expiresAt),
									lastUsedAt: instant(token.lastUsedAt),
									revokedAt: instant(token.revokedAt),
								},
							})),
						),
				),
		},
		/* No erase operation, deliberately: the audit spec excludes audit events
		   from erasure because they are the evidence the data lifecycle of a
		   workspace actually happened. Retention bounds them instead, and the
		   erasure certificate names this class not-erasable rather than claiming
		   it was cleared. */
		{
			key: 'audit-events',
			label: 'Authentication audit events',
			defaultRetentionDays: SECURITY_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteAuditEventsBefore(tenantId, cutoff.getTime(), batch(limit)),
			}),
			export: ({ tenantId, sink }) =>
				walk(sink, pageSize, 0, async (after, size) =>
					(await repository())
						.exportAuditEventsPage(tenantId, after, size)
						.then((page) =>
							page.map((event) => ({
								cursor: event.id,
								at: event.occurredAt,
								row: {
									...event,
									occurredAt: new Date(event.occurredAt).toISOString(),
								},
							})),
						),
				),
		},
	];
}

function batch(limit: number, ceiling = AUTH_SWEEP_LIMIT): number {
	return Math.max(1, Math.min(Math.trunc(limit), ceiling));
}

/**
 * One bounded erasure call. A full batch may have left more behind, so the
 * caller is told to come back. The answer over-approximates by one round when
 * the subject held exactly the batch, because repeating an erasure that removes
 * nothing is safe and reporting a class complete while rows of the subject
 * remain is not.
 */
async function eraseSubject(
	limit: number,
	remove: (size: number) => Promise<number>,
): Promise<DataClassErasureResult> {
	const size = batch(limit, AUTH_ERASE_LIMIT);
	const removed = await remove(size);
	return removed >= size ? { removed, truncated: true } : { removed };
}

function instant(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

/**
 * A keyset walk over one class. Pages are read by a unique ordered key, so the
 * walk terminates on a table that is still being written to and never holds
 * more than one page in memory. The cursor stays here: only `row` reaches the
 * sink.
 */
async function walk<Cursor>(
	sink: DataClassExportSink,
	pageSize: number,
	start: Cursor,
	read: (
		after: Cursor,
		limit: number,
	) => Promise<
		readonly {
			readonly cursor: Cursor;
			readonly at: number;
			readonly row: Record<string, unknown>;
		}[]
	>,
): Promise<DataClassExportSummary> {
	let after = start;
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const page = await read(after, pageSize);
		for (const entry of page) {
			const at = new Date(entry.at);
			if (!from || at < from) from = at;
			if (!to || at > to) to = at;
			after = entry.cursor;
			rows += 1;
			await sink.write(entry.row);
		}
		if (page.length < pageSize) return { rows, from, to };
	}
}
