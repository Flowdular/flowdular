import { createHash } from 'node:crypto';
import type { NotificationKind, WebhookEventPayload } from '../domain/types.ts';

export interface WebhookPayloadSource {
	readonly tenantId: string;
	readonly subscriptionId: string;
	readonly kind: NotificationKind;
	readonly sourceModule: string;
	readonly sourceRef: string;
	readonly title: string;
	readonly occurredAt: number;
}

/**
 * The body a subscription receives. Every field comes from the delivery row, so
 * the same event always produces the same bytes: a retry and a replay rebuild
 * it instead of reading a stored copy, and the digest stays comparable.
 */
export function webhookPayload(
	source: WebhookPayloadSource,
): WebhookEventPayload {
	return {
		version: 'notifications.v1',
		event: source.kind,
		tenantId: source.tenantId,
		subscriptionId: source.subscriptionId,
		sourceModule: source.sourceModule,
		sourceRef: source.sourceRef,
		title: source.title,
		occurredAt: source.occurredAt,
	};
}

/* Key order is fixed by the literal above, so JSON.stringify is deterministic
   and the digest is stable across processes. */
export function webhookPayloadBody(source: WebhookPayloadSource): string {
	return JSON.stringify(webhookPayload(source));
}

export interface PayloadFingerprint {
	readonly body: string;
	readonly digest: string;
	readonly bytes: number;
}

export function webhookPayloadFingerprint(
	source: WebhookPayloadSource,
): PayloadFingerprint {
	const body = webhookPayloadBody(source);
	return {
		body,
		digest: createHash('sha256').update(body, 'utf8').digest('hex'),
		bytes: Buffer.byteLength(body, 'utf8'),
	};
}

export interface EmailPayloadSource {
	readonly tenantId: string;
	readonly recipientAccountId: string;
	readonly kind: NotificationKind;
	readonly sourceModule: string;
	readonly sourceRef: string;
	readonly title: string;
	readonly occurredAt: number;
}

/**
 * What an e-mail attempt records in the ledger: the addressed event, not the
 * rendered message. The body is never copied onto the attempt row; it is read
 * from the member's inbox item when the message is built, so the ledger keeps
 * holding a digest and a size rather than a payload.
 */
export function emailPayloadFingerprint(
	source: EmailPayloadSource,
): PayloadFingerprint {
	/* Key order is fixed by the literal, so the digest is stable across
	   processes and comparable between attempts of one event. */
	const body = JSON.stringify({
		version: 'notifications.email.v1',
		event: source.kind,
		tenantId: source.tenantId,
		recipientAccountId: source.recipientAccountId,
		sourceModule: source.sourceModule,
		sourceRef: source.sourceRef,
		title: source.title,
		occurredAt: source.occurredAt,
	});
	return {
		body,
		digest: createHash('sha256').update(body, 'utf8').digest('hex'),
		bytes: Buffer.byteLength(body, 'utf8'),
	};
}
