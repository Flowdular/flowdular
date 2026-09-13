import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	approvalInputDigest,
	createApprovalGrantKeyring,
	keyFingerprint,
	verifyApprovalGrant,
} from '@flowdular/kernel';
import {
	APPROVAL_GRANT_CAPABILITY_ID_LENGTH,
	APPROVAL_GRANT_TTL_MS,
	decodeCapabilitySubjectRef,
	encodeCapabilitySubjectRef,
} from '../src/domain/grant.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	member,
	OWNER_ROLE,
	testClock,
} from './support/harness.ts';

const TENANT = 'tenant-a';
const REQUESTER = 'account-requester';
const DECIDER = 'account-ada';
const KEY_A = Buffer.alloc(32, 0x71);
const KEY_B = Buffer.alloc(32, 0x72);
const CAPABILITY = 'billing.export';
const DIGEST = approvalInputDigest({ arguments: ['acme'], flags: {} });
const SUBJECT = encodeCapabilitySubjectRef({
	capabilityId: CAPABILITY,
	inputDigest: DIGEST,
});

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

function fixture(keyring = createApprovalGrantKeyring({ current: KEY_A })) {
	const clock = testClock();
	const { service } = createHarness({
		repository: shared.repository,
		members: [member(REQUESTER, OWNER_ROLE), member(DECIDER, OWNER_ROLE)],
		now: clock.now,
		grants: keyring,
	});
	return { service, clock, capability: service.capability() };
}

const MODULE = 'billing.core';

async function open(context: ReturnType<typeof fixture>, subjectRef = SUBJECT) {
	return context.capability.open({
		tenantId: TENANT,
		subjectModule: MODULE,
		subjectRef,
		permission: 'billing.export.run',
		action: 'export',
		title: 'Export the ledger',
		requesterAccountId: REQUESTER,
		requirement: { roleKey: OWNER_ROLE },
	});
}

describe('capability subject encoding', () => {
	it('round-trips a capability id and an input digest within the subject bound', () => {
		expect(SUBJECT).toBe(`capability:${CAPABILITY}:${DIGEST}`);
		expect(SUBJECT.length).toBeLessThanOrEqual(200);
		expect(decodeCapabilitySubjectRef(SUBJECT)).toEqual({
			capabilityId: CAPABILITY,
			inputDigest: DIGEST,
		});
		expect(decodeCapabilitySubjectRef('product-4711')).toBeNull();
		expect(
			decodeCapabilitySubjectRef(`capability:${CAPABILITY}:short`),
		).toBeNull();
		expect(
			decodeCapabilitySubjectRef(`capability:Billing:${DIGEST}`),
		).toBeNull();
		expect(() =>
			encodeCapabilitySubjectRef({
				capabilityId: `a.${'b'.repeat(APPROVAL_GRANT_CAPABILITY_ID_LENGTH)}`,
				inputDigest: DIGEST,
			}),
		).toThrow(RangeError);
		expect(() =>
			encodeCapabilitySubjectRef({
				capabilityId: CAPABILITY,
				inputDigest: 'x',
			}),
		).toThrow(RangeError);
	});
});

describe('APPROVALS-GRANT', () => {
	it('yields a verifiable grant once the request is approved and records the issuance', async () => {
		const context = fixture();
		const request = await open(context);
		expect(
			await context.capability.grant(TENANT, request.id, MODULE),
		).toBeNull();
		expect(await shared.repository.listAudit(TENANT, request.id)).toEqual([]);

		context.clock.advance(1_000);
		await context.service.decide(TENANT, request.id, DECIDER, 'approve');

		const approved = await context.capability.get(TENANT, request.id);
		expect(approved?.status).toBe('approved');
		expect(approved).not.toHaveProperty('grant');
		const token = await context.capability.grant(TENANT, request.id, MODULE);
		const verified = verifyApprovalGrant(
			createApprovalGrantKeyring({ current: KEY_A }),
			token!,
			{ tenantId: TENANT, capabilityId: CAPABILITY, inputDigest: DIGEST },
			context.clock.now(),
		);
		expect(verified).toMatchObject({
			ok: true,
			claims: {
				tenantId: TENANT,
				capabilityId: CAPABILITY,
				inputDigest: DIGEST,
				requestId: request.id,
				issuedAt: approved!.resolvedAt,
				expiresAt: approved!.resolvedAt! + APPROVAL_GRANT_TTL_MS,
			},
		});
		/* Nothing about the token is stored: two reads derive the same one. */
		expect(await context.capability.grant(TENANT, request.id, MODULE)).toBe(
			token,
		);
		/* Only the module that opened the request is handed its grant. */
		expect(
			await context.capability.grant(TENANT, request.id, 'workflows.core'),
		).toBeNull();

		const audit = await shared.repository.listAudit(TENANT, request.id);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			tenantId: TENANT,
			requestId: request.id,
			action: 'grant.issued',
			occurredAt: approved!.resolvedAt,
			metadata: {
				capabilityId: CAPABILITY,
				inputDigest: DIGEST,
				keyId: keyFingerprint(KEY_A),
				expiresAt: approved!.resolvedAt! + APPROVAL_GRANT_TTL_MS,
			},
		});
	});

	it('yields no grant for a rejected, cancelled or expired request', async () => {
		const context = fixture();
		const rejected = await open(context);
		await context.service.decide(TENANT, rejected.id, DECIDER, 'reject');
		const cancelled = await open(context);
		await context.capability.cancel(TENANT, cancelled.id, REQUESTER);
		const expiring = await open(context);
		context.clock.advance(8 * 24 * 60 * 60 * 1_000);
		await context.service.expireRequest({
			tenantId: TENANT,
			id: expiring.id,
			expiresAt: expiring.expiresAt,
			status: 'pending',
		});

		for (const [id, status] of [
			[rejected.id, 'rejected'],
			[cancelled.id, 'cancelled'],
			[expiring.id, 'expired'],
		] as const) {
			expect((await context.capability.get(TENANT, id))?.status).toBe(status);
			expect(await context.capability.grant(TENANT, id, MODULE)).toBeNull();
			expect(await shared.repository.listAudit(TENANT, id)).toEqual([]);
		}
	});

	it('yields no grant for an approved request whose subject names a record', async () => {
		const context = fixture();
		const request = await open(context, 'product-4711');
		await context.service.decide(TENANT, request.id, DECIDER, 'approve');
		expect((await context.capability.get(TENANT, request.id))?.status).toBe(
			'approved',
		);
		expect(
			await context.capability.grant(TENANT, request.id, MODULE),
		).toBeNull();
		expect(await shared.repository.listAudit(TENANT, request.id)).toEqual([]);
	});

	it('stops yielding the grant once its window from the approval closed', async () => {
		const context = fixture();
		const request = await open(context);
		await context.service.decide(TENANT, request.id, DECIDER, 'approve');
		context.clock.advance(APPROVAL_GRANT_TTL_MS);
		expect(
			await context.capability.grant(TENANT, request.id, MODULE),
		).toBeNull();
	});

	it('signs under the current key after a rotation and still records the old issuance', async () => {
		const before = fixture();
		const request = await open(before);
		await before.service.decide(TENANT, request.id, DECIDER, 'approve');

		const rotated = fixture(
			createApprovalGrantKeyring({ current: KEY_B, previous: [KEY_A] }),
		);
		const token = await rotated.capability.grant(TENANT, request.id, MODULE);
		expect(token?.split('.')[1]).toBe(keyFingerprint(KEY_B));
		expect(
			verifyApprovalGrant(
				createApprovalGrantKeyring({ current: KEY_B, previous: [KEY_A] }),
				token!,
				{ tenantId: TENANT, capabilityId: CAPABILITY, inputDigest: DIGEST },
				rotated.clock.now(),
			).ok,
		).toBe(true);
		expect(
			(await shared.repository.listAudit(TENANT, request.id))[0]?.metadata
				.keyId,
		).toBe(keyFingerprint(KEY_A));
	});

	it('leaves the issuance ledger with the request when the sweep removes it', async () => {
		const context = fixture();
		const request = await open(context);
		await context.service.decide(TENANT, request.id, DECIDER, 'approve');
		expect(await shared.repository.listAudit(TENANT, request.id)).toHaveLength(
			1,
		);

		expect(
			await shared.repository.deleteResolvedBefore(
				TENANT,
				context.clock.now() + 1,
				10,
			),
		).toBe(1);
		expect(await shared.repository.listAudit(TENANT, request.id)).toEqual([]);
	});
});
