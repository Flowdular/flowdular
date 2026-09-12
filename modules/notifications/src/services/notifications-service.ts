import { randomUUID } from 'node:crypto';
import {
	DEFAULT_EMAIL_DELIVERY,
	INBOX_STATUSES,
	NOTIFICATION_KINDS,
	type MemberNotificationSettings,
	type NotificationKind,
	type NotificationPreference,
	type NotificationsInbox,
} from '../domain/types.ts';
import type { InboxFilters, NotificationsRepository } from './repository.ts';
import { bounded, NotificationsServiceError, oneOf } from './service-error.ts';

/** Most items one inbox request returns; the screen pages what it is given. */
export const INBOX_PAGE_LIMIT = 200;

/**
 * The member-facing half of the module. Every method takes the tenant and the
 * account id from the authenticated principal, and every statement filters on
 * both, so an item addressed to another member is simply not there.
 */
export class NotificationsService {
	constructor(private readonly repository: NotificationsRepository) {}

	/* Every entry point is async so a bound or enum rejection reaches the caller
	   as a rejected promise rather than a synchronous throw. */
	async list(
		tenantId: string,
		recipientAccountId: string,
		filters: InboxFilters = {},
	): Promise<readonly NotificationsInbox[]> {
		return this.repository.listInbox(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(recipientAccountId, 'recipientAccountId', 1, 128),
			{
				status: filters.status
					? oneOf(filters.status, 'status', INBOX_STATUSES)
					: undefined,
				kind: filters.kind
					? oneOf(filters.kind, 'kind', NOTIFICATION_KINDS)
					: undefined,
			},
			INBOX_PAGE_LIMIT,
		);
	}

	async unreadCount(
		tenantId: string,
		recipientAccountId: string,
	): Promise<number> {
		return this.repository.countUnreadInbox(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(recipientAccountId, 'recipientAccountId', 1, 128),
		);
	}

	async markRead(
		tenantId: string,
		recipientAccountId: string,
		itemId: string,
		now = Date.now(),
	): Promise<NotificationsInbox> {
		return this.#transition(
			tenantId,
			recipientAccountId,
			itemId,
			'read',
			new Date(now).toISOString(),
		);
	}

	async markUnread(
		tenantId: string,
		recipientAccountId: string,
		itemId: string,
	): Promise<NotificationsInbox> {
		return this.#transition(
			tenantId,
			recipientAccountId,
			itemId,
			'unread',
			null,
		);
	}

	/* Archiving keeps readAt: an archived item that was read stays read in the
	   ledger the member sees. */
	async archive(
		tenantId: string,
		recipientAccountId: string,
		itemId: string,
	): Promise<NotificationsInbox> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const account = bounded(recipientAccountId, 'recipientAccountId', 1, 128);
		const id = bounded(itemId, 'itemId', 1, 128);
		const existing = await this.repository.getInboxItem(
			trustedTenantId,
			account,
			id,
		);
		if (!existing) throw notFound();
		const updated = await this.repository.setInboxStatus(
			trustedTenantId,
			account,
			id,
			'archived',
			existing.readAt,
		);
		if (!updated) throw notFound();
		return updated;
	}

	async listPreferences(
		tenantId: string,
		recipientAccountId: string,
	): Promise<readonly NotificationPreference[]> {
		return this.repository.listPreferences(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(recipientAccountId, 'recipientAccountId', 1, 128),
		);
	}

	async savePreference(
		tenantId: string,
		recipientAccountId: string,
		kind: NotificationKind,
		enabled: boolean,
		now = Date.now(),
	): Promise<NotificationPreference> {
		return this.repository.savePreference({
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recipientAccountId: bounded(
				recipientAccountId,
				'recipientAccountId',
				1,
				128,
			),
			kind: oneOf(kind, 'kind', NOTIFICATION_KINDS),
			enabled: enabled === true,
			createdAt: now,
			updatedAt: now,
		});
	}

	/** The member's own workspace-wide switches; the defaults when none exist. */
	async memberSettings(
		tenantId: string,
		recipientAccountId: string,
	): Promise<MemberNotificationSettings> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const account = bounded(recipientAccountId, 'recipientAccountId', 1, 128);
		return (
			(await this.repository.getMemberSettings(trustedTenantId, account)) ?? {
				tenantId: trustedTenantId,
				recipientAccountId: account,
				emailDelivery: DEFAULT_EMAIL_DELIVERY,
				createdAt: 0,
				updatedAt: 0,
			}
		);
	}

	async saveEmailDelivery(
		tenantId: string,
		recipientAccountId: string,
		enabled: boolean,
		now = Date.now(),
	): Promise<MemberNotificationSettings> {
		return this.repository.saveMemberSettings({
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recipientAccountId: bounded(
				recipientAccountId,
				'recipientAccountId',
				1,
				128,
			),
			emailDelivery: enabled === true,
			createdAt: now,
			updatedAt: now,
		});
	}

	async #transition(
		tenantId: string,
		recipientAccountId: string,
		itemId: string,
		status: 'read' | 'unread',
		readAt: string | null,
	): Promise<NotificationsInbox> {
		const updated = await this.repository.setInboxStatus(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(recipientAccountId, 'recipientAccountId', 1, 128),
			bounded(itemId, 'itemId', 1, 128),
			status,
			readAt,
		);
		if (!updated) throw notFound();
		return updated;
	}
}

/* An item of another member and an item that never existed answer the same
   way: the caller must not learn that someone else's item exists. */
function notFound(): NotificationsServiceError {
	return new NotificationsServiceError(
		'INBOX_ITEM_NOT_FOUND',
		'Inbox item not found.',
		404,
	);
}

export { NotificationsServiceError } from './service-error.ts';
