import type { TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type {
	DeliveryStatus,
	NotificationKind,
	NotificationsInboxStatus,
	WebhookSubscriptionStatus,
} from '../domain/types.ts';

function formatted(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

/** Epoch milliseconds as the reader's local date and time. */
export function timestampLabel(value: number | null): string {
	if (value === null) return t('notifications.common.notYet');
	return formatted(value);
}

/** The inbox stores `readAt` as ISO text; an unparsable value stays visible. */
export function isoTimestampLabel(value: string | null): string {
	if (value === null || value === '') return t('notifications.common.notYet');
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? value : formatted(parsed);
}

/** The second line of a delivery's timing cell: when the attempt ended. */
export function deliveryCompletedLabel(value: number | null): string {
	if (value === null) return t('notifications.deliveries.timing.pending');
	return t('notifications.deliveries.timing.completed', {
		value: formatted(value),
	});
}

export function kindLabel(kind: NotificationKind): string {
	return t('notifications.kind.' + kind);
}

export function inboxStatusLabel(status: NotificationsInboxStatus): string {
	return t('notifications.status.' + status);
}

export function inboxStatusTone(status: NotificationsInboxStatus): TagTone {
	if (status === 'unread') return 'info';
	return status === 'read' ? 'success' : 'neutral';
}

export function subscriptionStatusLabel(
	status: WebhookSubscriptionStatus,
): string {
	return t('notifications.subscription.status.' + status);
}

export function subscriptionStatusTone(
	status: WebhookSubscriptionStatus,
): TagTone {
	if (status === 'active') return 'success';
	return status === 'paused' ? 'warning' : 'neutral';
}

export function deliveryStatusLabel(status: DeliveryStatus): string {
	return t('notifications.delivery.status.' + status);
}

export function deliveryStatusTone(status: DeliveryStatus): TagTone {
	if (status === 'succeeded') return 'success';
	if (status === 'pending') return 'info';
	return status === 'failed' ? 'warning' : 'danger';
}

/* The ledger stores a stable class the server may extend. An unknown class is
   shown as the server wrote it instead of being dropped. */
export function errorClassLabel(value: string | null): string {
	if (value === null || value === '') return '';
	const key = 'notifications.deliveries.errorClass.' + value;
	const translated = t(key);
	return translated === key ? value : translated;
}
