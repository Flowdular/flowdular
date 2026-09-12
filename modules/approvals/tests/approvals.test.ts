import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobRunner } from '@flowdular/server';
import type { ApprovalRequest } from '../src/domain/types.ts';
import { createApprovalsExpiryRunner } from '../src/services/expiry-runner.ts';
import type { NotificationPublishInput } from '../src/services/notifications.ts';
import type { ApprovalsRepository } from '../src/services/repository.ts';
import { ApprovalsServiceError } from '../src/services/service-error.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	DAY_MS,
	MEMBER_ROLE,
	member,
	OWNER_ROLE,
	testClock,
} from './support/harness.ts';

const TENANT = 'tenant-a';
const REQUESTER = 'account-requester';

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

interface Fixture {
	readonly members: ReturnType<typeof member>[];
	readonly publishes: NotificationPublishInput[];
	readonly resolved: ApprovalRequest[];
	readonly clock: ReturnType<typeof testClock>;
	readonly service: ReturnType<typeof createHarness>['service'];
}

function fixture(
	deciders: readonly string[] = ['account-ada', 'account-bo', 'account-cy'],
	options: { readonly notifications?: boolean } = { notifications: true },
): Fixture {
	const members = [
		member(REQUESTER, OWNER_ROLE),
		...deciders.map((accountId) => member(accountId, OWNER_ROLE)),
	];
	const publishes: NotificationPublishInput[] = [];
	const clock = testClock();
	const { service } = createHarness({
		repository: shared.repository,
		members,
		now: clock.now,
		...(options.notifications === false ? {} : { publishes }),
	});
	return { members, publishes, resolved: [], clock, service };
}

/** The module repository with some of its operations answered by the case. */
function wrap(overrides: Partial<ApprovalsRepository>): ApprovalsRepository {
	const base = shared.repository;
	return {
		create: base.create.bind(base),
		get: base.get.bind(base),
		findPendingBySubject: base.findPendingBySubject.bind(base),
		detail: base.detail.bind(base),
		list: base.list.bind(base),
		isSnapshotDecider: base.isSnapshotDecider.bind(base),
		countDecidable: base.countDecidable.bind(base),
		decide: base.decide.bind(base),
		listDueExpiries: base.listDueExpiries.bind(base),
		exportRequestsPage: base.exportRequestsPage.bind(base),
		deleteResolvedBefore: base.deleteResolvedBefore.bind(base),
		deleteResolvedRequestedBy: base.deleteResolvedRequestedBy.bind(base),
		redactDecisionsBy: base.redactDecisionsBy.bind(base),
		redactEligibilityOf: base.redactEligibilityOf.bind(base),
		countRequestedBy: base.countRequestedBy.bind(base),
		...overrides,
	};
}

/** The module repository with one request the tenant read cannot answer. */
function unreadable(requestId: string): ApprovalsRepository {
	return wrap({
		get: async (tenantId, id) => {
			if (id === requestId) throw new Error('tenant database unreachable');
			return shared.repository.get(tenantId, id);
		},
	});
}

/** One expiry pass on the platform job runner, over the case's own clock. */
function expiry(
	service: Fixture['service'],
	repository: ApprovalsRepository,
	now: () => number,
): JobRunner {
	return createApprovalsExpiryRunner({
		repository: async () => repository,
		service: async () => service,
		intervalMs: 60_000,
		now,
	});
}

function openInput(
	context: Fixture,
	overrides: Partial<Parameters<Fixture['service']['open']>[0]> = {},
) {
	return {
		tenantId: TENANT,
		subjectModule: 'catalog.core',
		subjectRef: 'product-4711',
		permission: 'catalog.products.manage',
		action: 'publish',
		title: 'Publish product 4711',
		summary: 'The price changed by more than 20 percent.',
		requesterAccountId: REQUESTER,
		requirement: { roleKey: OWNER_ROLE, decisions: 1 },
		onResolved: async (request: ApprovalRequest) => {
			context.resolved.push(request);
		},
		...overrides,
	};
}

describe('APPROVALS-OPEN', () => {
	it('APPROVALS-OPEN persists a pending request with the resolved deciders and notifies them', async () => {
		const context = fixture();
		const request = await context.service.open(openInput(context));

		expect(request.status).toBe('pending');
		expect(request.decisionsNeeded).toBe(1);
		expect(request.expiresAt).toBe(context.clock.now() + 7 * DAY_MS);
		expect(request.requirement).toEqual({
			roleKey: OWNER_ROLE,
			scope: null,
			decisions: 1,
			expiresInDays: 7,
		});

		/* The requester is excluded and the three eligible members are not, which
		   is observable through the list each of them gets. */
		for (const accountId of ['account-ada', 'account-bo', 'account-cy']) {
			expect([
				accountId,
				(await context.service.list(TENANT, { decidableBy: accountId })).map(
					(entry) => entry.id,
				),
			]).toEqual([accountId, [request.id]]);
		}
		expect(
			await context.service.list(TENANT, { decidableBy: REQUESTER }),
		).toHaveLength(0);
		expect(
			(await context.service.list(TENANT, { requesterAccountId: REQUESTER }))
				.length,
		).toBe(1);

		expect(context.publishes).toHaveLength(1);
		expect(context.publishes[0]).toMatchObject({
			tenantId: TENANT,
			kind: 'approval-requested',
			sourceModule: 'approvals.core',
			sourceRef: request.id,
			recipients: ['account-ada', 'account-bo', 'account-cy'],
		});
	});

	it('APPROVALS-OPEN applies the workspace default expiry when the requirement names none', async () => {
		const clock = testClock();
		const { service } = createHarness({
			repository: shared.repository,
			members: [member(REQUESTER), member('account-ada')],
			now: clock.now,
			defaultExpiryDays: 3,
		});
		const request = await service.open({
			tenantId: TENANT,
			subjectModule: 'catalog.core',
			subjectRef: 'product-1',
			permission: 'catalog.products.manage',
			action: 'publish',
			title: 'Publish',
			requesterAccountId: REQUESTER,
			requirement: { roleKey: OWNER_ROLE },
		});
		expect(request.expiresAt).toBe(clock.now() + 3 * DAY_MS);
	});

	it('APPROVALS-OPEN refuses a requirement nobody in the workspace satisfies', async () => {
		const context = fixture([]);
		await expect(
			context.service.open(openInput(context)),
		).rejects.toMatchObject({ code: 'APPROVAL_NO_ELIGIBLE_DECIDER' });
	});

	it('APPROVALS-OPEN refuses a requirement asking for more approvals than there are deciders', async () => {
		const context = fixture(['account-ada']);
		await expect(
			context.service.open(
				openInput(context, {
					requirement: { roleKey: OWNER_ROLE, decisions: 2 },
				}),
			),
		).rejects.toMatchObject({ code: 'APPROVAL_ELIGIBLE_INSUFFICIENT' });
	});

	it('APPROVALS-OPEN returns the open request instead of asking the same question twice', async () => {
		const context = fixture();
		const first = await context.service.open(openInput(context));
		const second = await context.service.open(openInput(context));

		expect(second.id).toBe(first.id);
		expect(context.publishes).toHaveLength(1);
		expect(
			await context.service.list(TENANT, { subjectRef: 'product-4711' }),
		).toHaveLength(1);
	});

	it('APPROVALS-OPEN returns the open request after the only eligible decider left', async () => {
		const context = fixture(['account-ada']);
		const first = await context.service.open(openInput(context));

		/* The workspace can no longer field a decider. The question is already
		   asked, so reopening it must answer with the request that is asking. */
		const index = context.members.findIndex(
			(entry) => entry.accountId === 'account-ada',
		);
		context.members.splice(index, 1);

		const second = await context.service.open(openInput(context));
		expect(second.id).toBe(first.id);
		expect(second.status).toBe('pending');
		expect(context.publishes).toHaveLength(1);
	});

	it('APPROVALS-OPEN asks every eligible decider when there are more than one notification carries', async () => {
		const deciders = Array.from(
			{ length: 100 },
			(_, index) => `account-decider-${String(index).padStart(3, '0')}`,
		);
		const context = fixture(deciders);
		const request = await context.service.open(openInput(context));

		const requested = context.publishes.filter(
			(entry) => entry.kind === 'approval-requested',
		);
		/* notifications.core refuses more than 64 accounts in one call, so a wide
		   requirement is published in batches instead of losing the rest. */
		expect(requested.map((entry) => entry.recipients.length)).toEqual([64, 36]);
		expect(requested.every((entry) => entry.sourceRef === request.id)).toBe(
			true,
		);
		expect(requested.flatMap((entry) => [...entry.recipients]).sort()).toEqual(
			[...deciders].sort(),
		);
	});

	it('APPROVALS-OPEN continues without notifying when notifications.core is absent', async () => {
		const context = fixture(['account-ada'], { notifications: false });
		const request = await context.service.open(openInput(context));
		expect(request.status).toBe('pending');
	});

	it('APPROVALS-OPEN records the request even when the publisher throws', async () => {
		const clock = testClock();
		const publishes: NotificationPublishInput[] = [];
		const { service } = createHarness({
			repository: shared.repository,
			members: [member(REQUESTER), member('account-ada')],
			now: clock.now,
			publishes,
			publisherThrows: true,
		});
		const request = await service.open({
			tenantId: TENANT,
			subjectModule: 'catalog.core',
			subjectRef: 'product-9',
			permission: 'catalog.products.manage',
			action: 'publish',
			title: 'Publish',
			requesterAccountId: REQUESTER,
			requirement: { roleKey: OWNER_ROLE },
		});
		expect((await service.get(TENANT, request.id))?.status).toBe('pending');
		expect(publishes).toHaveLength(0);
	});
});

describe('APPROVALS-DECIDE', () => {
	it('APPROVALS-DECIDE resolves on the second approval, refuses the third and runs the callback once', async () => {
		const context = fixture();
		const request = await context.service.open(
			openInput(context, {
				requirement: { roleKey: OWNER_ROLE, decisions: 2 },
			}),
		);

		const first = await context.service.decide(
			TENANT,
			request.id,
			'account-ada',
			'approve',
			'Looks right.',
		);
		expect(first.request.status).toBe('pending');
		expect(first.request.resolvedAt).toBeNull();
		expect(first.decisions).toHaveLength(1);
		expect(context.resolved).toHaveLength(0);

		context.clock.advance(1_000);
		const second = await context.service.decide(
			TENANT,
			request.id,
			'account-bo',
			'approve',
		);
		expect(second.request.status).toBe('approved');
		expect(second.request.resolvedAt).toBe(context.clock.now());
		expect(second.decisions.map((entry) => entry.deciderAccountId)).toEqual([
			'account-ada',
			'account-bo',
		]);

		await expect(
			context.service.decide(TENANT, request.id, 'account-cy', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });

		expect(context.resolved.map((entry) => entry.status)).toEqual(['approved']);
		expect(
			context.publishes.filter((entry) => entry.kind === 'approval-decided'),
		).toEqual([
			expect.objectContaining({
				sourceRef: request.id,
				recipients: [REQUESTER],
			}),
		]);
	});

	it('APPROVALS-DECIDE refuses a second decision by the same member', async () => {
		const context = fixture();
		const request = await context.service.open(
			openInput(context, {
				requirement: { roleKey: OWNER_ROLE, decisions: 3 },
			}),
		);
		await context.service.decide(TENANT, request.id, 'account-ada', 'approve');
		await expect(
			context.service.decide(TENANT, request.id, 'account-ada', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
		expect(
			(await context.service.detail(TENANT, request.id))?.decisions,
		).toHaveLength(1);
	});
});

describe('APPROVALS-REJECT', () => {
	it('APPROVALS-REJECT resolves on the first rejection and accepts nothing after it', async () => {
		const context = fixture();
		const request = await context.service.open(
			openInput(context, {
				requirement: { roleKey: OWNER_ROLE, decisions: 2 },
			}),
		);
		const rejected = await context.service.decide(
			TENANT,
			request.id,
			'account-ada',
			'reject',
			'The price is wrong.',
		);
		expect(rejected.request.status).toBe('rejected');
		expect(rejected.decisions).toEqual([
			expect.objectContaining({
				decision: 'reject',
				deciderAccountId: 'account-ada',
				comment: 'The price is wrong.',
			}),
		]);
		await expect(
			context.service.decide(TENANT, request.id, 'account-bo', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
		expect(context.resolved.map((entry) => entry.status)).toEqual(['rejected']);
	});
});

describe('APPROVALS-INELIGIBLE', () => {
	it('APPROVALS-INELIGIBLE refuses the requester, a member without the role and a member who lost it', async () => {
		const context = fixture();
		context.members.push(member('account-outsider', MEMBER_ROLE));
		const request = await context.service.open(openInput(context));

		/* The requester may read their own request, so they are told they may not
		   decide it. A member the request never named learns nothing about it. */
		for (const [accountId, code] of [
			[REQUESTER, 'APPROVAL_NOT_ELIGIBLE'],
			['account-outsider', 'APPROVAL_NOT_FOUND'],
			['account-ghost', 'APPROVAL_NOT_FOUND'],
		] as const) {
			await expect([
				accountId,
				await context.service
					.decide(TENANT, request.id, accountId, 'approve')
					.catch((error: unknown) =>
						error instanceof ApprovalsServiceError ? error.code : 'other',
					),
			]).toEqual([accountId, code]);
		}

		/* Eligible at creation, demoted since: the snapshot still names them and
		   the live check is what refuses the decision. */
		const index = context.members.findIndex(
			(entry) => entry.accountId === 'account-ada',
		);
		context.members[index] = member('account-ada', MEMBER_ROLE);
		await expect(
			context.service.decide(TENANT, request.id, 'account-ada', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_ELIGIBLE' });

		expect((await context.service.get(TENANT, request.id))?.status).toBe(
			'pending',
		);
		expect(
			(await context.service.detail(TENANT, request.id))?.decisions,
		).toHaveLength(0);
	});

	it('APPROVALS-INELIGIBLE refuses a member who holds the role but not the required scope', async () => {
		const context = fixture([]);
		context.members.push(
			member('account-ada', OWNER_ROLE, ['catalog.products.manage']),
			member('account-bo', OWNER_ROLE, []),
		);
		const request = await context.service.open(
			openInput(context, {
				requirement: { roleKey: OWNER_ROLE, scope: 'catalog.products.manage' },
			}),
		);
		/* The scope is what the snapshot was resolved on, so a member without it
		   is not named by the request and is answered as if it did not exist. */
		await expect(
			context.service.decide(TENANT, request.id, 'account-bo', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
		/* A member holding manage reads every request, and is told the truth:
		   they may read it and may not decide it. */
		await expect(
			context.service.decide(
				TENANT,
				request.id,
				'account-bo',
				'approve',
				null,
				{ manage: true },
			),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_ELIGIBLE' });
	});

	it('APPROVALS-INELIGIBLE lets a member who became eligible after the request decide it', async () => {
		const context = fixture(['account-ada']);
		const request = await context.service.open(openInput(context));
		/* The snapshot was taken before this member held the role, so readability
		   cannot come from it: live eligibility is what admits the decision. */
		context.members.push(member('account-late', OWNER_ROLE));

		const detail = await context.service.decide(
			TENANT,
			request.id,
			'account-late',
			'approve',
		);
		expect(detail.request.status).toBe('approved');
		expect(detail.decisions).toEqual([
			expect.objectContaining({ deciderAccountId: 'account-late' }),
		]);
	});
});

describe('APPROVALS-EXPIRE', () => {
	it('APPROVALS-EXPIRE expires a due request once, runs the callback and accepts nothing after it', async () => {
		const context = fixture();
		const request = await context.service.open(openInput(context));
		const runner = expiry(
			context.service,
			shared.repository,
			context.clock.now,
		);

		expect(await runner.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});

		context.clock.advance(7 * DAY_MS + 1);
		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});
		/* A second pass claims nothing: the request is no longer pending. */
		expect(await runner.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});

		const detail = await context.service.detail(TENANT, request.id);
		expect(detail?.request.status).toBe('expired');
		expect(detail?.request.resolvedAt).toBe(context.clock.now());
		expect(detail?.decisions).toEqual([
			expect.objectContaining({ decision: 'expire', deciderAccountId: null }),
		]);
		expect(context.resolved.map((entry) => entry.status)).toEqual(['expired']);

		await expect(
			context.service.decide(TENANT, request.id, 'account-ada', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
	});

	it('APPROVALS-EXPIRE expires the rest of the pass when one request cannot be read', async () => {
		const context = fixture();
		const failing = await context.service.open(openInput(context));
		const first = await context.service.open(
			openInput(context, { subjectRef: 'product-4712' }),
		);
		const second = await context.service.open(
			openInput(context, { subjectRef: 'product-4713' }),
		);

		/* One workspace whose read fails must not cost every workspace behind it
		   in the same pass its expiry: the runner isolates the request that raised
		   and claims the next one. */
		const repository = unreadable(failing.id);
		const { service } = createHarness({
			repository,
			members: context.members,
			now: context.clock.now,
		});
		context.clock.advance(7 * DAY_MS + 1);

		expect(await expiry(service, repository, context.clock.now).tick()).toEqual(
			{ claimed: 3, performed: 2, failed: 1, claimLost: 0 },
		);
		expect((await context.service.get(TENANT, failing.id))?.status).toBe(
			'pending',
		);
		for (const request of [first, second]) {
			expect((await context.service.get(TENANT, request.id))?.status).toBe(
				'expired',
			);
		}
	});

	it('APPROVALS-EXPIRE leaves a request decided between the routing read and the write alone', async () => {
		const context = fixture();
		const request = await context.service.open(openInput(context));
		context.clock.advance(7 * DAY_MS + 1);
		/* The claim hands over the routing row as the poll read it, while the
		   request was still pending; the decision lands before the pass writes. */
		const due = await shared.repository.listDueExpiries(
			context.clock.now(),
			10,
		);
		await context.service.decide(TENANT, request.id, 'account-ada', 'approve');

		expect(
			await expiry(
				context.service,
				wrap({ listDueExpiries: async () => due }),
				context.clock.now,
			).tick(),
		).toEqual({ claimed: 1, performed: 1, failed: 0, claimLost: 0 });

		const detail = await context.service.detail(TENANT, request.id);
		expect(detail?.request.status).toBe('approved');
		expect(detail?.decisions.map((entry) => entry.decision)).toEqual([
			'approve',
		]);
	});
});

describe('APPROVALS-CANCEL', () => {
	it('APPROVALS-CANCEL lets the requester and a manager cancel, and publishes no decision notification', async () => {
		const context = fixture();
		const mine = await context.service.open(openInput(context));
		const other = await context.service.open(
			openInput(context, { subjectRef: 'product-4712' }),
		);

		const byRequester = await context.service.cancel(
			TENANT,
			mine.id,
			REQUESTER,
		);
		expect(byRequester.request.status).toBe('cancelled');
		expect(byRequester.decisions).toEqual([
			expect.objectContaining({
				decision: 'cancel',
				deciderAccountId: REQUESTER,
			}),
		]);

		const byManager = await context.service.cancel(
			TENANT,
			other.id,
			'account-ada',
			{ manage: true },
		);
		expect(byManager.request.status).toBe('cancelled');

		expect(
			context.publishes.filter((entry) => entry.kind === 'approval-decided'),
		).toHaveLength(0);
		expect(context.resolved.map((entry) => entry.status)).toEqual([
			'cancelled',
			'cancelled',
		]);
	});

	it('APPROVALS-CANCEL refuses a member who is neither the requester nor a manager', async () => {
		const context = fixture();
		const request = await context.service.open(openInput(context));
		await expect(
			context.service.cancel(TENANT, request.id, 'account-ada'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_CANCELLABLE' });
		expect((await context.service.get(TENANT, request.id))?.status).toBe(
			'pending',
		);
	});

	it('APPROVALS-CANCEL answers a member the request never named as if it did not exist', async () => {
		const context = fixture();
		context.members.push(member('account-outsider', MEMBER_ROLE));
		const request = await context.service.open(openInput(context));

		await expect(
			context.service.cancel(TENANT, request.id, 'account-outsider'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
		/* The same member must learn nothing from a resolved request either: the
		   status is exactly what a refusal before the read rule would leak. */
		await context.service.cancel(TENANT, request.id, REQUESTER);
		await expect(
			context.service.cancel(TENANT, request.id, 'account-outsider'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
		await expect(
			context.service.decide(TENANT, request.id, 'account-outsider', 'approve'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
	});
});

describe('approvals membership reads', () => {
	it('asks auth.core for the deciding member alone, and for the roll only when a request opens', async () => {
		const reads = { roll: 0, single: 0 };
		const clock = testClock();
		const members = [member(REQUESTER), member('account-ada')];
		const { service } = createHarness({
			repository: shared.repository,
			members,
			reads,
			now: clock.now,
		});
		const request = await service.open({
			tenantId: TENANT,
			subjectModule: 'catalog.core',
			subjectRef: 'product-reads',
			permission: 'catalog.products.manage',
			action: 'publish',
			title: 'Publish',
			requesterAccountId: REQUESTER,
			requirement: { roleKey: OWNER_ROLE },
		});
		expect(reads).toEqual({ roll: 1, single: 0 });

		await service.viewerRights(request, 'account-ada', {
			decide: true,
			manage: false,
		});
		await service.decide(TENANT, request.id, 'account-ada', 'approve');
		/* Judging one account must not cost the whole workspace roll, whatever
		   size the workspace is. */
		expect(reads).toEqual({ roll: 1, single: 2 });
	});
});

describe('approvals capability', () => {
	it('exposes open, get, list and cancel, and cancels only as the requester', async () => {
		const context = fixture();
		const capability = context.service.capability();
		const request = await capability.open(openInput(context));

		expect((await capability.get(TENANT, request.id))?.id).toBe(request.id);
		expect(
			(await capability.list(TENANT, { subjectModule: 'catalog.core' })).map(
				(entry) => entry.id,
			),
		).toEqual([request.id]);
		await expect(
			capability.cancel(TENANT, request.id, 'account-ada'),
		).rejects.toMatchObject({ code: 'APPROVAL_NOT_CANCELLABLE' });
		expect(
			(await capability.cancel(TENANT, request.id, REQUESTER)).status,
		).toBe('cancelled');
	});

	it('counts only the pending requests a member may decide', async () => {
		const context = fixture();
		const first = await context.service.open(openInput(context));
		await context.service.open(openInput(context, { subjectRef: 'other' }));

		expect(await context.service.countDecidable(TENANT, 'account-ada')).toBe(2);
		expect(await context.service.countDecidable(TENANT, REQUESTER)).toBe(0);
		await context.service.decide(TENANT, first.id, 'account-ada', 'approve');
		expect(await context.service.countDecidable(TENANT, 'account-ada')).toBe(1);
	});

	it('runs a resolution callback at most once even when it throws', async () => {
		const clock = testClock();
		let calls = 0;
		const { service } = createHarness({
			repository: shared.repository,
			members: [member(REQUESTER), member('account-ada')],
			now: clock.now,
		});
		const request = await service.open({
			tenantId: TENANT,
			subjectModule: 'catalog.core',
			subjectRef: 'product-callback',
			permission: 'catalog.products.manage',
			action: 'publish',
			title: 'Publish',
			requesterAccountId: REQUESTER,
			requirement: { roleKey: OWNER_ROLE },
			onResolved: async () => {
				calls += 1;
				throw new Error('subject module is down');
			},
		});
		const decided = await service.decide(
			TENANT,
			request.id,
			'account-ada',
			'approve',
		);
		expect(decided.request.status).toBe('approved');
		expect(calls).toBe(1);
	});
});
