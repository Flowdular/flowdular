import type { UserActor } from '@flowdular/kernel';

/* The notifications.core publish contract, declared here rather than imported.
   notifications.core is optional: agents.core composes, runs and settles runs
   with that module absent, so it may not be a package dependency. This mirror
   is the contract notifications.core owns and must not drift from it.
   modules/workflows/src/services/notifications.ts holds the same mirror and
   stays identical to this file apart from the module id; change both. */
export const NOTIFICATIONS_PUBLISH_CAPABILITY = 'notifications.publish.v1';

export type NotificationKind =
	| 'agent-run-completed'
	| 'agent-run-failed'
	| 'workflow-run-completed'
	| 'workflow-run-failed'
	| 'webhook-dead-letter'
	| 'approval-requested'
	| 'approval-decided'
	| 'meter-threshold';

export interface NotificationPublishInput {
	readonly tenantId: string;
	readonly kind: NotificationKind;
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
   register notifications.core after agents.core, or never. */
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

/* The person accountable for the run. The service that enqueued it already
   derived and validated one: the member who started the run, or the member who
   configured the service identity that did. A run with no person behind it,
   such as one an agent started for itself, has nobody to notify. */
export function runNotificationRecipients(
	authorizationSubject: UserActor | null,
): readonly string[] {
	return authorizationSubject ? [authorizationSubject.id] : [];
}

/* Advisory and post-commit. An absent notifications module, nobody to notify,
   or a publisher that throws never changes a settled run, so this never
   rejects. The caller passes the run id as sourceRef, which makes a retried
   terminal step publish the same notification instead of a second one. */
export async function publishRunOutcome(
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
			`[agents] notification publish for run ${input.sourceRef} failed:`,
			error instanceof Error ? error.message : error,
		);
	}
}
