import { randomUUID } from 'node:crypto';
import {
	APPROVAL_LIMITS,
	type ApprovalRequestFilter,
	type ApprovalsRequests,
	type OpenApprovalInput,
} from '../domain/capability.ts';
import {
	APPROVAL_STATUSES,
	type ApprovalDecision,
	type ApprovalMember,
	type ApprovalRequest,
	type ApprovalRequestDetail,
	type ApprovalViewerRights,
	type TerminalApprovalStatus,
} from '../domain/types.ts';
import {
	createApprovalCallbackRegistry,
	type ApprovalCallbackRegistry,
} from './callbacks.ts';
import {
	memberSatisfies,
	normalizeRequirement,
	resolveEligible,
} from './eligibility.ts';
import {
	publishApprovalEvent,
	type NotificationPublisherResolver,
} from './notifications.ts';
import type { ApprovalsRepository } from './repository.ts';
import {
	ApprovalsServiceError,
	bounded,
	boundedInteger,
	optionalBounded,
	oneOf,
} from './service-error.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Requests one page of a list answers with; the platform ceiling is 200. */
export const APPROVALS_PAGE_LIMIT = 100;

/** Requests one expiry pass takes. The next tick continues where it stopped. */
export const EXPIRY_BATCH = 100;

export interface ApprovalsServiceOptions {
	readonly repository: ApprovalsRepository;
	/** Active members and their live role and scopes, resolved through auth.core. */
	readonly members: (tenantId: string) => Promise<readonly ApprovalMember[]>;
	/**
	 * One member's live role and scopes. Every path that judges a single account
	 * asks for that account; the roll is read only when a request opens and the
	 * whole eligibility snapshot has to be resolved.
	 */
	readonly member: (
		tenantId: string,
		accountId: string,
	) => Promise<ApprovalMember | null>;
	/** Live tenant setting applied when a requirement names no expiry. */
	readonly defaultExpiryDays: (tenantId: string) => number;
	readonly notifications?: NotificationPublisherResolver;
	readonly callbacks?: ApprovalCallbackRegistry;
	readonly now?: () => number;
}

export class ApprovalsService {
	readonly #repository: ApprovalsRepository;
	readonly #members: ApprovalsServiceOptions['members'];
	readonly #member: ApprovalsServiceOptions['member'];
	readonly #defaultExpiryDays: ApprovalsServiceOptions['defaultExpiryDays'];
	readonly #notifications: NotificationPublisherResolver | undefined;
	readonly #callbacks: ApprovalCallbackRegistry;
	readonly #now: () => number;

	constructor(options: ApprovalsServiceOptions) {
		this.#repository = options.repository;
		this.#members = options.members;
		this.#member = options.member;
		this.#defaultExpiryDays = options.defaultExpiryDays;
		this.#notifications = options.notifications;
		this.#callbacks = options.callbacks ?? createApprovalCallbackRegistry();
		this.#now = options.now ?? Date.now;
	}

	async open(input: OpenApprovalInput): Promise<ApprovalRequest> {
		const tenantId = bounded(input.tenantId, 'tenantId', 1, 128);
		const subjectModule = bounded(
			input.subjectModule,
			'subjectModule',
			1,
			APPROVAL_LIMITS.subjectModule,
		);
		const subjectRef = bounded(
			input.subjectRef,
			'subjectRef',
			1,
			APPROVAL_LIMITS.subjectRef,
		);
		const requesterAccountId = bounded(
			input.requesterAccountId,
			'requesterAccountId',
			1,
			APPROVAL_LIMITS.accountId,
		);
		const requirement = normalizeRequirement(
			input.requirement,
			this.#defaultExpiryDays(tenantId),
		);
		const permission = bounded(
			input.permission,
			'permission',
			1,
			APPROVAL_LIMITS.permission,
		);
		const action = bounded(input.action, 'action', 1, APPROVAL_LIMITS.action);
		const title = bounded(input.title, 'title', 1, APPROVAL_LIMITS.title);
		const summary = optionalBounded(
			input.summary,
			'summary',
			APPROVAL_LIMITS.summary,
		);
		/* A repeat of an open request asks who may decide nothing at all: the
		   deciders were named when it opened, and resolving eligibility again
		   would refuse the repeat once the only eligible member has left. */
		const open = await this.#repository.findPendingBySubject(
			tenantId,
			subjectModule,
			subjectRef,
		);
		if (open) {
			if (input.onResolved) {
				this.#callbacks.register(tenantId, open.id, input.onResolved);
			}
			return open;
		}
		const eligible = resolveEligible(
			requirement,
			await this.#members(tenantId),
			requesterAccountId,
		);
		const createdAt = this.#now();
		const request: ApprovalRequest = {
			id: randomUUID(),
			tenantId,
			subjectModule,
			subjectRef,
			permission,
			action,
			title,
			summary,
			requesterAccountId,
			requirement,
			decisionsNeeded: requirement.decisions,
			status: 'pending',
			expiresAt: createdAt + requirement.expiresInDays * DAY_MS,
			resolvedAt: null,
			createdAt,
		};
		const result = await this.#repository.create(request, eligible);
		if (input.onResolved) {
			this.#callbacks.register(tenantId, result.request.id, input.onResolved);
		}
		/* A repeat of an open request asks nobody a second time: the deciders
		   already have the notification the first call published. */
		if (result.created) {
			await publishApprovalEvent(this.#notifications, {
				tenantId,
				kind: 'approval-requested',
				sourceModule: 'approvals.core',
				sourceRef: result.request.id,
				title: result.request.title,
				...(result.request.summary === null
					? {}
					: { body: result.request.summary }),
				recipients: eligible,
			});
		}
		return result.request;
	}

	async get(tenantId: string, id: string): Promise<ApprovalRequest | null> {
		return this.#repository.get(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
		);
	}

	async detail(
		tenantId: string,
		id: string,
	): Promise<ApprovalRequestDetail | null> {
		return this.#repository.detail(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
		);
	}

	async list(
		tenantId: string,
		filter: ApprovalRequestFilter,
	): Promise<readonly ApprovalRequest[]> {
		return this.#repository.list(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				status:
					filter.status === undefined
						? undefined
						: oneOf(filter.status, 'status', APPROVAL_STATUSES),
				subjectModule: filter.subjectModule,
				subjectRef: filter.subjectRef,
				requesterAccountId: filter.requesterAccountId,
				decidableBy: filter.decidableBy,
			},
			boundedInteger(
				filter.limit ?? APPROVALS_PAGE_LIMIT,
				'limit',
				1,
				APPROVAL_LIMITS.listLimit,
			),
		);
	}

	/**
	 * Whether an account may see one request at all: the member who asked, a
	 * member the eligibility snapshot names, or a member holding manage. It is
	 * a read rule; deciding is re-checked against live membership.
	 */
	async canRead(
		request: ApprovalRequest,
		accountId: string,
		manage: boolean,
	): Promise<boolean> {
		if (manage || request.requesterAccountId === accountId) return true;
		return this.#repository.isSnapshotDecider(
			request.tenantId,
			request.id,
			accountId,
		);
	}

	/**
	 * What one member may do with one request. Deciding is answered against live
	 * membership, the same check the decision itself runs, so a screen and the
	 * server never disagree about who may act.
	 */
	async viewerRights(
		request: ApprovalRequest,
		accountId: string,
		grants: { readonly decide: boolean; readonly manage: boolean },
	): Promise<ApprovalViewerRights> {
		const pending = request.status === 'pending';
		let canDecide = false;
		if (pending && grants.decide) {
			const member = await this.#member(request.tenantId, accountId);
			canDecide =
				member !== null &&
				memberSatisfies(
					request.requirement,
					member,
					request.requesterAccountId,
				);
		}
		return {
			accountId,
			canDecide,
			canCancel:
				pending && (grants.manage || request.requesterAccountId === accountId),
		};
	}

	async countDecidable(tenantId: string, accountId: string): Promise<number> {
		return this.#repository.countDecidable(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(accountId, 'accountId', 1, APPROVAL_LIMITS.accountId),
		);
	}

	/**
	 * Records one approval or rejection. Eligibility is checked against live
	 * membership, never against the snapshot the request opened with, so a
	 * member who lost the role since cannot decide. A member who may neither
	 * read nor decide the request is answered as if it did not exist.
	 */
	async decide(
		tenantId: string,
		id: string,
		accountId: string,
		kind: 'approve' | 'reject',
		comment?: string | null,
		options: { readonly manage: boolean } = { manage: false },
	): Promise<ApprovalRequestDetail> {
		const request = await this.#existing(tenantId, id);
		const member = await this.#member(request.tenantId, accountId);
		const decider =
			member !== null &&
			memberSatisfies(request.requirement, member, request.requesterAccountId)
				? member
				: null;
		/* Live eligibility grants the read on its own: the snapshot cannot name a
		   member who became eligible after the request opened, and that member may
		   still decide. */
		if (!decider && !(await this.canRead(request, accountId, options.manage))) {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_FOUND',
				'The approval request was not found.',
				404,
			);
		}
		this.#assertPending(request);
		if (!decider) {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_ELIGIBLE',
				'You may not decide this request.',
				403,
			);
		}
		return this.#record(
			request,
			{
				deciderAccountId: decider.accountId,
				decision: kind,
				comment: optionalBounded(comment, 'comment', APPROVAL_LIMITS.comment),
			},
			(decisions) =>
				kind === 'reject'
					? 'rejected'
					: decisions.filter((entry) => entry.decision === 'approve').length >=
						  request.decisionsNeeded
						? 'approved'
						: null,
			/* A cancellation is the outcome its requester already knows about; an
			   approval or a rejection is the one they are waiting for. */
			true,
		);
	}

	/**
	 * Cancels a pending request. `manage` is the caller's answer to whether the
	 * actor holds `approvals.requests.manage`; the requester may always cancel
	 * their own request without it. A member who may not read the request is
	 * answered as if it did not exist.
	 */
	async cancel(
		tenantId: string,
		id: string,
		actorAccountId: string,
		options: { readonly manage: boolean } = { manage: false },
	): Promise<ApprovalRequestDetail> {
		const actor = bounded(
			actorAccountId,
			'actorAccountId',
			1,
			APPROVAL_LIMITS.accountId,
		);
		const request = await this.#existing(tenantId, id);
		if (!(await this.canRead(request, actor, options.manage))) {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_FOUND',
				'The approval request was not found.',
				404,
			);
		}
		this.#assertPending(request);
		if (!options.manage && actor !== request.requesterAccountId) {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_CANCELLABLE',
				'Only the requester or a member who may manage requests can cancel this request.',
				403,
			);
		}
		return this.#record(
			request,
			{ deciderAccountId: actor, decision: 'cancel', comment: null },
			() => 'cancelled',
			false,
		);
	}

	/**
	 * One expiry pass. The routing read is cross-tenant and carries routing
	 * columns only; every request it names is read again under its own tenant
	 * and expired only while it is still pending and still due.
	 */
	async expireDue(limit = EXPIRY_BATCH): Promise<number> {
		const now = this.#now();
		const due = await this.#repository.listDueExpiries(now, limit);
		let expired = 0;
		for (const routing of due) {
			/* One workspace that cannot be read or written must not cost every
			   other workspace its expiries; the next pass reads this one again. */
			try {
				const request = await this.#repository.get(
					routing.tenantId,
					routing.id,
				);
				if (!request || request.status !== 'pending') continue;
				if (request.expiresAt > now) continue;
				await this.#record(
					request,
					{ deciderAccountId: null, decision: 'expire', comment: null },
					() => 'expired',
					true,
				);
				expired += 1;
			} catch (error) {
				console.warn(
					`[approvals] expiry of request ${routing.id} failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
		return expired;
	}

	/** The implementation behind `approvals.requests.v1`. */
	capability(): ApprovalsRequests {
		return {
			open: (input) => this.open(input),
			get: (tenantId, id) => this.get(tenantId, id),
			list: (tenantId, filter) => this.list(tenantId, filter),
			cancel: async (tenantId, id, actorAccountId) =>
				(await this.cancel(tenantId, id, actorAccountId)).request,
		};
	}

	async #existing(tenantId: string, id: string): Promise<ApprovalRequest> {
		const request = await this.get(tenantId, id);
		if (!request) {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_FOUND',
				'The approval request was not found.',
				404,
			);
		}
		return request;
	}

	/* Only a member who may read the request is told its state; every caller
	   settles readability before this runs. */
	#assertPending(request: ApprovalRequest): void {
		if (request.status !== 'pending') {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_PENDING',
				`The request is already ${request.status}.`,
				409,
			);
		}
	}

	async #record(
		request: ApprovalRequest,
		decision: Pick<
			ApprovalDecision,
			'deciderAccountId' | 'decision' | 'comment'
		>,
		resolve: (
			decisions: readonly ApprovalDecision[],
		) => TerminalApprovalStatus | null,
		notifyRequester: boolean,
	): Promise<ApprovalRequestDetail> {
		const decidedAt = this.#now();
		const result = await this.#repository.decide({
			tenantId: request.tenantId,
			requestId: request.id,
			decision: {
				id: randomUUID(),
				tenantId: request.tenantId,
				requestId: request.id,
				...decision,
				decidedAt,
			},
			resolve,
			resolvedAt: decidedAt,
		});
		if (result.outcome === 'not-found') {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_FOUND',
				'The approval request was not found.',
				404,
			);
		}
		if (result.outcome === 'not-pending') {
			throw new ApprovalsServiceError(
				'APPROVAL_NOT_PENDING',
				`The request is already ${result.request.status}.`,
				409,
			);
		}
		if (result.outcome === 'duplicate') {
			throw new ApprovalsServiceError(
				'APPROVAL_ALREADY_DECIDED',
				'You already decided this request.',
				409,
			);
		}
		/* Both happen after the deciding transaction committed, and a failure in
		   either never changes what the ledger recorded. */
		if (result.resolved) {
			if (notifyRequester) {
				await publishApprovalEvent(this.#notifications, {
					tenantId: result.request.tenantId,
					kind: 'approval-decided',
					sourceModule: 'approvals.core',
					sourceRef: result.request.id,
					title: result.request.title,
					body: `The request is ${result.request.status}.`,
					recipients: [result.request.requesterAccountId],
				});
			}
			await this.#callbacks.run(result.request);
		}
		return { request: result.request, decisions: result.decisions };
	}
}

export { ApprovalsServiceError } from './service-error.ts';
