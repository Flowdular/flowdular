/* The notifications.core publish contract, declared here rather than imported.
   notifications.core is optional: approvals.core composes, opens and resolves
   requests with that module absent, so it is not a package dependency. This
   mirror carries only the two kinds this module publishes; notifications.core
   owns the full set and this must not drift from the shape it accepts. */
export const NOTIFICATIONS_PUBLISH_CAPABILITY = 'notifications.publish.v1';

export type ApprovalNotificationKind =
	| 'approval-requested'
	| 'approval-decided';

export interface NotificationPublishInput {
	readonly tenantId: string;
	readonly kind: ApprovalNotificationKind;
	readonly sourceModule: string;
	readonly sourceRef: string;
	readonly title: string;
	readonly body?: string;
	readonly recipients: readonly string[];
}

export interface NotificationPublishResult {
	readonly inboxItemIds: readonly string[];
	readonly deliveryIds: readonly string[];
}

export interface NotificationPublisher {
	publish(input: NotificationPublishInput): Promise<NotificationPublishResult>;
}

/* Read at the point of use, never at composition time: the platform may
   register notifications.core after approvals.core, or never. */
export type NotificationPublisherResolver = () => NotificationPublisher | null;

const LIMITS = {
	sourceModule: 64,
	sourceRef: 200,
	title: 200,
	body: 4_000,
	recipients: 64,
	recipientId: 128,
} as const;

function clamp(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Advisory and post-commit. An absent notifications module, nobody to notify,
 * or a publisher that throws never changes a recorded decision, so this never
 * rejects. The caller passes the request id as `sourceRef`, which makes a
 * repeated publication of the same event idempotent on the receiving side.
 *
 * A requirement may name more deciders than notifications.core accepts in one
 * call, so the recipients are published in batches of that size. Every batch
 * carries the same `sourceRef`, which is what makes them one event on the
 * receiving side; truncating instead would leave deciders unasked.
 */
export async function publishApprovalEvent(
	resolve: NotificationPublisherResolver | undefined,
	input: NotificationPublishInput,
): Promise<void> {
	if (input.recipients.length === 0) return;
	try {
		const publisher = resolve?.();
		if (!publisher) return;
		const event = {
			tenantId: input.tenantId,
			kind: input.kind,
			sourceModule: clamp(input.sourceModule, LIMITS.sourceModule),
			sourceRef: clamp(input.sourceRef, LIMITS.sourceRef),
			title: clamp(input.title, LIMITS.title),
			...(input.body === undefined
				? {}
				: { body: clamp(input.body, LIMITS.body) }),
		};
		for (
			let index = 0;
			index < input.recipients.length;
			index += LIMITS.recipients
		) {
			await publisher.publish({
				...event,
				recipients: input.recipients
					.slice(index, index + LIMITS.recipients)
					.map((recipient) => clamp(recipient, LIMITS.recipientId)),
			});
		}
	} catch (error) {
		console.warn(
			`[approvals] notification publish for request ${input.sourceRef} failed:`,
			error instanceof Error ? error.message : error,
		);
	}
}
