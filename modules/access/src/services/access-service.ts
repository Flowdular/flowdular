import { randomUUID } from 'node:crypto';
import type { DataClassExportSink } from '@flowdular/kernel';
import {
	ACCESS_LIMITS,
	type AccessAttestation,
	type AccessChangePage,
	type AccessReview,
	type AccessReviewMemberPage,
	type AccessWindow,
	type AttestationPage,
	type AttestationPosition,
	type AuditPosition,
} from '../domain/types.ts';
import { walkAuditWindow } from './audit-window.ts';
import type { AccessReportKind } from './changes.ts';
import type { AccessDirectory } from './directory.ts';
import type { AccessRepository } from './repository.ts';
import { buildReview, reviewMembers } from './review.ts';

export class AccessServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'AccessServiceError';
	}
}

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Rows one export page reads; the walk repeats until the ledger is done. */
const EXPORT_PAGE = 200;

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AccessServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new AccessServiceError(
			'INVALID_INPUT',
			`${field} contains an unsupported character.`,
		);
	}
	return normalized;
}

/**
 * A reported window is two UTC calendar dates with an inclusive end, bounded
 * before anything is read so a report can never ask the trail for a decade.
 */
export function parseWindow(from: string, to: string): AccessWindow {
	if (!CALENDAR_DATE.test(from) || !CALENDAR_DATE.test(to)) {
		throw new AccessServiceError(
			'INVALID_INPUT',
			'from and to must be calendar dates in the form YYYY-MM-DD.',
		);
	}
	const start = Date.parse(`${from}T00:00:00.000Z`);
	const end = Date.parse(`${to}T23:59:59.999Z`);
	/* A day past the end of its month parses by rolling over, so the parsed
	   instant is compared back against the text: 2026-02-30 is not a date the
	   reader meant and is refused rather than silently read as 2 March. */
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		new Date(start).toISOString().slice(0, 10) !== from ||
		new Date(end).toISOString().slice(0, 10) !== to
	) {
		throw new AccessServiceError(
			'INVALID_INPUT',
			'from and to must be real calendar dates.',
		);
	}
	if (end < start) {
		throw new AccessServiceError(
			'RANGE_REVERSED',
			'The end of the period is before its start.',
		);
	}
	if (end - start > ACCESS_LIMITS.rangeDays * DAY_MS) {
		throw new AccessServiceError(
			'RANGE_TOO_LONG',
			`A period covers at most ${ACCESS_LIMITS.rangeDays} days.`,
		);
	}
	return { from: start, to: end };
}

export interface AccessServiceOptions {
	readonly repository: AccessRepository;
	readonly directory: AccessDirectory;
	readonly now?: () => number;
}

export interface AttestInput {
	readonly window: AccessWindow;
	readonly note: string | null;
}

export interface Reviewer {
	readonly accountId: string;
	readonly label: string;
}

export class AccessService {
	readonly #repository: AccessRepository;
	readonly #directory: AccessDirectory;
	readonly #now: () => number;

	constructor(options: AccessServiceOptions) {
		this.#repository = options.repository;
		this.#directory = options.directory;
		this.#now = options.now ?? (() => Date.now());
	}

	/** Who holds what right now, computed per call and never stored. */
	review(tenantId: string): Promise<AccessReview> {
		return buildReview(this.#directory, this.#tenant(tenantId), this.#now());
	}

	/**
	 * One page of the review's memberships, walked by account id. The review
	 * itself lists at most `ACCESS_LIMITS.members` and says it was capped, which
	 * is honest for a screen and wrong for a file: a workspace past that bound
	 * would export a truncated roll. This reads the uncapped paged surface
	 * instead, so the number of pages grows with the workspace and what reaches
	 * the file never depends on a listing bound.
	 */
	async memberPage(
		tenantId: string,
		cursor: string | null,
		limit: number,
	): Promise<AccessReviewMemberPage> {
		const owner = this.#tenant(tenantId);
		const [page, roles] = await Promise.all([
			this.#directory.memberPage(
				owner,
				cursor,
				this.#pageLimit(limit, ACCESS_LIMITS.memberPage),
			),
			this.#directory.roles(owner),
		]);
		return {
			members: reviewMembers(page.members, roles),
			nextCursor: page.nextCursor,
		};
	}

	changes(
		tenantId: string,
		kind: AccessReportKind,
		window: AccessWindow,
		page: { readonly limit: number; readonly after: AuditPosition | null },
	): Promise<AccessChangePage> {
		return walkAuditWindow(this.#directory, this.#tenant(tenantId), {
			window,
			kind,
			limit: this.#pageLimit(page.limit, ACCESS_LIMITS.reportLimit),
			after: page.after,
		});
	}

	/**
	 * Records that someone reviewed the access of a period. The counts are the
	 * server's own reading of the workspace at this moment: a caller supplies
	 * the period and the note, never the evidence.
	 */
	async attest(
		tenantId: string,
		reviewer: Reviewer,
		input: AttestInput,
	): Promise<AccessAttestation> {
		const owner = this.#tenant(tenantId);
		const review = await this.review(owner);
		return this.#repository.append({
			id: randomUUID(),
			tenantId: owner,
			reviewerAccountId: bounded(
				reviewer.accountId,
				'reviewerAccountId',
				1,
				ACCESS_LIMITS.accountId,
			),
			reviewerLabel: bounded(
				reviewer.label,
				'reviewerLabel',
				1,
				ACCESS_LIMITS.label,
			),
			periodFrom: new Date(input.window.from).toISOString(),
			periodTo: new Date(input.window.to).toISOString(),
			memberCount: review.counts.members,
			activeMemberCount: review.counts.activeMembers,
			roleCount: review.counts.roles,
			extraScopeCount: review.counts.extraScopeGrants,
			tokenCount: review.counts.tokens,
			providerCount: review.counts.providers,
			note:
				input.note === null
					? null
					: bounded(input.note, 'note', 1, ACCESS_LIMITS.note),
			createdAt: this.#now(),
		});
	}

	async attestations(
		tenantId: string,
		query: {
			readonly limit: number;
			readonly after: AttestationPosition | null;
		},
	): Promise<AttestationPage> {
		const limit = this.#pageLimit(query.limit, ACCESS_LIMITS.attestationLimit);
		const items = await this.#repository.list(this.#tenant(tenantId), {
			limit,
			after: query.after,
		});
		const last = items.at(-1);
		return {
			items,
			/* A full page may still be the last one; a client stops when the
			   cursor stops, which costs one empty page at most. */
			next:
				last && items.length === limit
					? { createdAt: last.createdAt, id: last.id }
					: null,
		};
	}

	/** The data class export: the whole ledger of one workspace, oldest first. */
	async exportAttestations(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<{ rows: number; from: Date | null; to: Date | null }> {
		const owner = this.#tenant(tenantId);
		let after: AttestationPosition | null = null;
		let rows = 0;
		let from: number | null = null;
		let to: number | null = null;
		for (;;) {
			const page: readonly AccessAttestation[] =
				await this.#repository.exportPage(owner, after, EXPORT_PAGE);
			for (const record of page) {
				await sink.write({
					id: record.id,
					reviewerAccountId: record.reviewerAccountId,
					reviewerLabel: record.reviewerLabel,
					periodFrom: record.periodFrom,
					periodTo: record.periodTo,
					memberCount: record.memberCount,
					activeMemberCount: record.activeMemberCount,
					roleCount: record.roleCount,
					extraScopeCount: record.extraScopeCount,
					tokenCount: record.tokenCount,
					providerCount: record.providerCount,
					note: record.note,
					createdAt: new Date(record.createdAt).toISOString(),
				});
				rows += 1;
				if (from === null || record.createdAt < from) from = record.createdAt;
				if (to === null || record.createdAt > to) to = record.createdAt;
			}
			if (page.length < EXPORT_PAGE) break;
			const last = page[page.length - 1]!;
			after = { createdAt: last.createdAt, id: last.id };
		}
		return {
			rows,
			from: from === null ? null : new Date(from),
			to: to === null ? null : new Date(to),
		};
	}

	#tenant(tenantId: string): string {
		return bounded(tenantId, 'tenantId', 1, ACCESS_LIMITS.tenantId);
	}

	#pageLimit(limit: number, maximum: number): number {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
			throw new AccessServiceError(
				'INVALID_INPUT',
				`limit must be a whole number between 1 and ${maximum}.`,
			);
		}
		return limit;
	}
}
