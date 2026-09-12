/* The notifications.core publish contract, declared here rather than imported.
   notifications.core is optional: metering.core composes, records and refuses
   with that module absent, so it may not be a package dependency. This mirror
   is the contract notifications.core owns and must not drift from it.
   modules/agents/src/services/notifications.ts holds the same mirror. */
export const NOTIFICATIONS_PUBLISH_CAPABILITY = 'notifications.publish.v1';

export interface NotificationPublishInput {
	readonly tenantId: string;
	readonly kind: 'meter-threshold';
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
   register notifications.core after metering.core, or never. */
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

/* Advisory and post-commit. An absent notifications module, nobody to notify,
   or a publisher that throws never changes a recorded fact, so this never
   rejects. The threshold row was already claimed, which is what keeps a
   published notification to one per meter per month per threshold. */
export async function publishThresholdNotice(
	resolve: NotificationPublisherResolver | undefined,
	input: NotificationPublishInput,
): Promise<void> {
	if (input.recipients.length === 0) return;
	try {
		const publisher = resolve?.();
		if (!publisher) return;
		await publisher.publish({
			tenantId: input.tenantId,
			kind: input.kind,
			sourceModule: clamp(input.sourceModule, LIMITS.sourceModule),
			sourceRef: clamp(input.sourceRef, LIMITS.sourceRef),
			title: clamp(input.title, LIMITS.title),
			...(input.body === undefined
				? {}
				: { body: clamp(input.body, LIMITS.body) }),
			recipients: input.recipients
				.slice(0, LIMITS.recipients)
				.map((recipient) => clamp(recipient, LIMITS.recipientId)),
		});
	} catch (error) {
		console.warn(
			`[metering] threshold notification for ${input.sourceRef} failed:`,
			error instanceof Error ? error.message : error,
		);
	}
}
