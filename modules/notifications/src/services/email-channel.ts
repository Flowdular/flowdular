import { randomUUID } from 'node:crypto';
import {
	renderMailTemplate,
	type MailMessage,
	type MailTemplate,
} from '@flowdular/server';
import type { DeliveryAttempt, NotificationsInbox } from '../domain/types.ts';
import { emailPayloadFingerprint } from './delivery-payload.ts';

/* The e-mail channel of the delivery queue: what a queued attempt looks like
   and what the member receives. The message is built from the member's own
   inbox item, so an attempt row still carries a digest and a size rather than a
   payload, and a retry sends what the item says now. */

const TEMPLATE: MailTemplate = {
	subject: '{{subject}}',
	text: '{{title}}\n\n{{body}}\n',
	html: '<p><strong>{{title}}</strong></p><p>{{body}}</p>',
};

/* A subject is one header line, and the port refuses one that is not. The title
   is collapsed rather than refused here: the item exists already, so a title
   that reached the store before it was kept to one line must still be mailable
   instead of failing every attempt of the same message. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The first attempt for one member of one published event. It shares the
 * queue, the claim, the retry budget and the dead letter with a webhook
 * attempt; only the target and the transport differ.
 */
export function emailDeliveryAttempt(
	item: NotificationsInbox,
	createdAt: number,
): DeliveryAttempt {
	const payload = emailPayloadFingerprint({
		tenantId: item.tenantId,
		recipientAccountId: item.recipientAccountId,
		kind: item.kind,
		sourceModule: item.sourceModule,
		sourceRef: item.sourceRef,
		title: item.title,
		occurredAt: item.createdAt,
	});
	return {
		id: randomUUID(),
		tenantId: item.tenantId,
		channel: 'email',
		subscriptionId: null,
		recipientAccountId: item.recipientAccountId,
		kind: item.kind,
		sourceModule: item.sourceModule,
		sourceRef: item.sourceRef,
		title: item.title,
		sequence: 1,
		attemptNumber: 1,
		status: 'pending',
		scheduledFor: item.createdAt,
		completedAt: null,
		responseStatus: null,
		errorClass: null,
		payloadDigest: payload.digest,
		payloadBytes: payload.bytes,
		occurredAt: item.createdAt,
		createdAt,
	};
}

/**
 * The message one inbox item becomes. The title and the body are the member's
 * own; the template helper escapes both for the HTML part, so a published title
 * can never open a tag.
 */
export function notificationMailMessage(
	item: NotificationsInbox,
	address: string,
	locale: string,
): MailMessage {
	return {
		to: address,
		...renderMailTemplate(
			{ ...TEMPLATE, locale },
			{
				subject: item.title.replace(CONTROL_CHARACTERS, ' '),
				title: item.title,
				body: item.body ?? '',
			},
		),
		/* Provenance a mail client can filter on; it names the kind and nothing
		   about the workspace or the member. */
		headers: { 'x-flowdular-notification': item.kind },
	};
}
