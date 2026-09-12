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
