import { ApprovalsService } from '../../src/services/approvals-service.ts';
import { createApprovalCallbackRegistry } from '../../src/services/callbacks.ts';
import type { NotificationPublishInput } from '../../src/services/notifications.ts';
import type { ApprovalsRepository } from '../../src/services/repository.ts';
import type { ApprovalMember } from '../../src/domain/types.ts';

export const OWNER_ROLE = 'owner';
export const MEMBER_ROLE = 'member';

export function member(
	accountId: string,
	roleKey = OWNER_ROLE,
	scopes: readonly string[] = ['approvals.requests.decide'],
): ApprovalMember {
	return { accountId, roleKey, scopes };
}

export interface HarnessOptions {
	readonly repository: ApprovalsRepository;
	/** Live membership; a test mutates the array to revoke a role mid-flight. */
	readonly members: ApprovalMember[];
	/** Counts each read of the membership, by surface, for the reads a path takes. */
	readonly reads?: { roll: number; single: number };
	readonly now?: () => number;
	readonly defaultExpiryDays?: number;
	/** Absent means notifications.core is not composed. */
	readonly publishes?: NotificationPublishInput[];
	/** Made to throw, to prove a publisher failure changes no decision. */
	readonly publisherThrows?: boolean;
}

export function createHarness(options: HarnessOptions) {
	const callbacks = createApprovalCallbackRegistry();
	const service = new ApprovalsService({
		repository: options.repository,
		members: async () => {
			if (options.reads) options.reads.roll += 1;
			return options.members;
		},
		/* auth.core answers one account; the array is the stand-in for the store
		   it reads, so a test revoking a role mid-flight is seen by both reads. */
		member: async (_tenantId, accountId) => {
			if (options.reads) options.reads.single += 1;
			return (
				options.members.find((entry) => entry.accountId === accountId) ?? null
			);
		},
		defaultExpiryDays: () => options.defaultExpiryDays ?? 7,
		callbacks,
		...(options.publishes
			? {
					notifications: () => ({
						publish: async (input: NotificationPublishInput) => {
							if (options.publisherThrows) {
								throw new Error('publisher unavailable');
							}
							options.publishes!.push(input);
							return { inboxItemIds: [], deliveryIds: [] };
						},
					}),
				}
			: {}),
		...(options.now ? { now: options.now } : {}),
	});
	return { service, callbacks };
}

/** A clock a test moves by hand, so expiry never waits on real time. */
export function testClock(start = 1_700_000_000_000) {
	let value = start;
	return {
		now: () => value,
		advance(ms: number) {
			value += ms;
		},
		set(next: number) {
			value = next;
		},
	};
}

export const DAY_MS = 24 * 60 * 60 * 1_000;
