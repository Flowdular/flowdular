import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'x-flowdular-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-flowdular-timestamp';
export const WEBHOOK_SIGNATURE_VERSION = 'v1';
/* Matches the inbound automations trigger window, so a customer implements one
   freshness rule for both directions. */
export const WEBHOOK_FRESHNESS_MS = 300_000;

/** What is signed: the scheme version, the sent timestamp, and the raw body. */
export function webhookSignedPayload(timestamp: string, body: string): string {
	return `${WEBHOOK_SIGNATURE_VERSION}.${timestamp}.${body}`;
}

export function webhookSignature(secret: string, signed: string): string {
	return createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
}

/** The exact value of the `x-flowdular-signature` header. */
export function webhookSignatureHeader(
	secret: string,
	timestamp: string,
	body: string,
): string {
	return `${WEBHOOK_SIGNATURE_VERSION}=${webhookSignature(
		secret,
		webhookSignedPayload(timestamp, body),
	)}`;
}

function constantTimeEquals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

export interface OutboundSignatureCheck {
	readonly secret: string;
	/** Raw `x-flowdular-signature` header value, including the `v1=` prefix. */
	readonly signature: string | null;
	/** Raw `x-flowdular-timestamp` header value. */
	readonly timestamp: string | null;
	/** Request body exactly as received, before any parsing. */
	readonly body: string;
	readonly now?: number;
	readonly toleranceMs?: number;
}

/**
 * The receiver side of the scheme, shared with customers and used by the tests.
 * Verification is constant time and the timestamp is part of the signed string,
 * so the freshness window cannot be forged by editing the header.
 *
 * `body` is the raw bytes, before parsing: the signature covers them, not the
 * object they decode to. A verified body is the JSON
 * `{ version, event, tenantId, subscriptionId, sourceModule, sourceRef, title,
 * occurredAt }`, with the details behind `sourceRef` in the source module.
 */
export function verifyOutboundSignature(
	check: OutboundSignatureCheck,
): boolean {
	const timestamp = check.timestamp ?? '';
	const prefix = `${WEBHOOK_SIGNATURE_VERSION}=`;
	const submitted = (check.signature ?? '').startsWith(prefix)
		? (check.signature ?? '').slice(prefix.length)
		: '';
	const expected = webhookSignature(
		check.secret,
		webhookSignedPayload(timestamp, check.body),
	);
	const sent = Number(timestamp);
	const fresh =
		/^\d{1,15}$/.test(timestamp) &&
		Number.isSafeInteger(sent) &&
		Math.abs((check.now ?? Date.now()) - sent) <=
			(check.toleranceMs ?? WEBHOOK_FRESHNESS_MS);
	return constantTimeEquals(submitted, expected) && fresh;
}
