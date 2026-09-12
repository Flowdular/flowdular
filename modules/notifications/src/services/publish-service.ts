import { randomUUID } from 'node:crypto';
import {
	PUBLISH_LIMITS,
	type NotificationPublishInput,
	type NotificationPublishResult,
	type NotificationPublisher,
} from '../domain/publish.ts';
import {
	NOTIFICATION_KINDS,
	type DeliveryAttempt,
	type NotificationsInbox,
	type WebhookSubscription,
} from '../domain/types.ts';
import { webhookPayloadFingerprint } from './delivery-payload.ts';
import { emailDeliveryAttempt } from './email-channel.ts';
import type { NotificationsRepository } from './repository.ts';
import {
	bounded,
	NotificationsServiceError,
	oneOf,
	singleLine,
} from './service-error.ts';

/**
 * The implementation behind `notifications.publish.v1`. Everything it writes
 * happens in one tenant-scoped write transaction, and the whole publication is
 * idempotent on (tenantId, kind, sourceRef).
 */
export class NotificationPublishService implements NotificationPublisher {
	constructor(
		private readonly repository: NotificationsRepository,
		private readonly now: () => number = Date.now,
	) {}

	async publish(
		input: NotificationPublishInput,
	): Promise<NotificationPublishResult> {
		const tenantId = bounded(input.tenantId, 'tenantId', 1, 128);
		const kind = oneOf(input.kind, 'kind', NOTIFICATION_KINDS);
		const sourceModule = bounded(
			input.sourceModule,
			'sourceModule',
			1,
			PUBLISH_LIMITS.sourceModule,
		);
		const sourceRef = bounded(
			input.sourceRef,
			'sourceRef',
			1,
			PUBLISH_LIMITS.sourceRef,
		);
		/* The title becomes the subject of the e-mail the item is mailed as. */
		const title = singleLine(input.title, 'title', 1, PUBLISH_LIMITS.title);
		const body =
			input.body === undefined || input.body.trim() === ''
				? null
				: bounded(input.body, 'body', 1, PUBLISH_LIMITS.body);
		if (input.recipients.length > PUBLISH_LIMITS.recipients) {
			throw new NotificationsServiceError(
				'INVALID_INPUT',
				`recipients must name at most ${PUBLISH_LIMITS.recipients} accounts.`,
			);
		}
		const recipients = [
			...new Set(
				input.recipients.map((account) =>
					bounded(account, 'recipient', 1, PUBLISH_LIMITS.accountId),
				),
			),
		];
		const occurredAt = this.now();

		const inboxItem = (recipientAccountId: string): NotificationsInbox => ({
			id: randomUUID(),
			tenantId,
			recipientAccountId,
			kind,
			title,
			body,
			sourceModule,
			sourceRef,
			status: 'unread',
			readAt: null,
			createdAt: occurredAt,
		});

		const delivery = (subscription: WebhookSubscription): DeliveryAttempt => {
			const payload = webhookPayloadFingerprint({
				tenantId,
				subscriptionId: subscription.id,
				kind,
				sourceModule,
				sourceRef,
				title,
				occurredAt,
			});
			return {
				id: randomUUID(),
				tenantId,
				channel: 'webhook',
				subscriptionId: subscription.id,
				recipientAccountId: null,
				kind,
				sourceModule,
				sourceRef,
				title,
				sequence: 1,
				attemptNumber: 1,
				status: 'pending',
				scheduledFor: occurredAt,
				completedAt: null,
				responseStatus: null,
				errorClass: null,
				payloadDigest: payload.digest,
				payloadBytes: payload.bytes,
				occurredAt,
				createdAt: occurredAt,
			};
		};

		return this.repository.publish({
			tenantId,
			kind,
			sourceRef,
			recipients,
			inboxItem,
			delivery,
			/* Built from the item the member receives, so the queued attempt and the
			   inbox row always describe the same event. */
			emailDelivery: (item) => emailDeliveryAttempt(item, occurredAt),
		});
	}
}
