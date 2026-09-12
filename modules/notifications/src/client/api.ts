import { t } from '@flowdular/client/i18n';
import type {
	CreateWebhookSubscriptionInput,
	DeliveryAttempt,
	DeliveryStatus,
	NotificationKind,
	NotificationPreference,
	NotificationsInbox,
	NotificationsInboxStatus,
	WebhookSubscription,
	WebhookSubscriptionSecret,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class NotificationsApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'NotificationsApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function notificationsErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof NotificationsApiError) {
		const key = 'notifications.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new NotificationsApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('notifications.error.request'),
		);
	}
	return value;
}

async function get<T>(path: string): Promise<T> {
	return payload<T>(
		await fetch(path, {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	return payload<T>(
		await fetch(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': csrfToken,
			},
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
}

function query(entries: Readonly<Record<string, string>>): string {
	const parameters = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		if (value !== '') parameters.set(key, value);
	}
	const text = parameters.toString();
	return text === '' ? '' : '?' + text;
}

export interface InboxFilter {
	readonly status?: NotificationsInboxStatus | '';
	readonly kind?: NotificationKind | '';
}

export async function loadInbox(
	filter: InboxFilter = {},
): Promise<readonly NotificationsInbox[]> {
	return (
		await get<{ readonly inbox: readonly NotificationsInbox[] }>(
			'/api/notifications/inbox' +
				query({ status: filter.status ?? '', kind: filter.kind ?? '' }),
		)
	).inbox;
}

export async function loadUnreadCount(): Promise<number> {
	return (
		await get<{ readonly unread: number }>(
			'/api/notifications/inbox/unread-count',
		)
	).unread;
}

async function inboxTransition(
	path: string,
	id: string,
	csrfToken: string,
): Promise<NotificationsInbox> {
	return (
		await post<{ readonly item: NotificationsInbox }>(path, { id }, csrfToken)
	).item;
}

export async function markInboxRead(
	id: string,
	csrfToken: string,
): Promise<NotificationsInbox> {
	return inboxTransition('/api/notifications/inbox/mark-read', id, csrfToken);
}

export async function markInboxUnread(
	id: string,
	csrfToken: string,
): Promise<NotificationsInbox> {
	return inboxTransition('/api/notifications/inbox/mark-unread', id, csrfToken);
}

export async function archiveInboxItem(
	id: string,
	csrfToken: string,
): Promise<NotificationsInbox> {
	return inboxTransition('/api/notifications/inbox/archive', id, csrfToken);
}

export interface NotificationPreferences {
	readonly kinds: readonly NotificationKind[];
	readonly preferences: readonly NotificationPreference[];
}

export async function loadPreferences(): Promise<NotificationPreferences> {
	return get<NotificationPreferences>('/api/notifications/preferences');
}

export async function savePreference(
	kind: NotificationKind,
	enabled: boolean,
	csrfToken: string,
): Promise<NotificationPreference> {
	return (
		await post<{ readonly preference: NotificationPreference }>(
			'/api/notifications/preferences/save',
			{ kind, enabled },
			csrfToken,
		)
	).preference;
}

export async function loadWebhooks(): Promise<readonly WebhookSubscription[]> {
	return (
		await get<{ readonly subscriptions: readonly WebhookSubscription[] }>(
			'/api/notifications/webhooks',
		)
	).subscriptions;
}

/** The response that carries the secret; it is never readable again. */
export async function createWebhook(
	input: CreateWebhookSubscriptionInput,
	csrfToken: string,
): Promise<WebhookSubscriptionSecret> {
	return post<WebhookSubscriptionSecret>(
		'/api/notifications/webhooks',
		input,
		csrfToken,
	);
}

export async function updateWebhook(
	id: string,
	input: CreateWebhookSubscriptionInput,
	csrfToken: string,
): Promise<WebhookSubscription> {
	return (
		await post<{ readonly subscription: WebhookSubscription }>(
			'/api/notifications/webhooks/update',
			{ id, ...input },
			csrfToken,
		)
	).subscription;
}

async function webhookTransition(
	path: string,
	id: string,
	csrfToken: string,
): Promise<WebhookSubscription> {
	return (
		await post<{ readonly subscription: WebhookSubscription }>(
			path,
			{ id },
			csrfToken,
		)
	).subscription;
}

export async function pauseWebhook(
	id: string,
	csrfToken: string,
): Promise<WebhookSubscription> {
	return webhookTransition('/api/notifications/webhooks/pause', id, csrfToken);
}

export async function resumeWebhook(
	id: string,
	csrfToken: string,
): Promise<WebhookSubscription> {
	return webhookTransition('/api/notifications/webhooks/resume', id, csrfToken);
}

export async function disableWebhook(
	id: string,
	csrfToken: string,
): Promise<WebhookSubscription> {
	return webhookTransition(
		'/api/notifications/webhooks/disable',
		id,
		csrfToken,
	);
}

/** The second and last response that carries a secret. */
export async function rotateWebhookSecret(
	id: string,
	csrfToken: string,
): Promise<WebhookSubscriptionSecret> {
	return post<WebhookSubscriptionSecret>(
		'/api/notifications/webhooks/rotate-secret',
		{ id },
		csrfToken,
	);
}

export async function deleteWebhook(
	id: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: string }>(
		'/api/notifications/webhooks/delete',
		{ id },
		csrfToken,
	);
}

export interface DeliveryFilter {
	readonly status?: DeliveryStatus | '';
	readonly subscriptionId?: string;
}

export async function loadDeliveries(
	filter: DeliveryFilter = {},
): Promise<readonly DeliveryAttempt[]> {
	return (
		await get<{ readonly deliveries: readonly DeliveryAttempt[] }>(
			'/api/notifications/deliveries' +
				query({
					status: filter.status ?? '',
					subscription: filter.subscriptionId ?? '',
				}),
		)
	).deliveries;
}

export async function replayDelivery(
	id: string,
	csrfToken: string,
): Promise<DeliveryAttempt> {
	return (
		await post<{ readonly delivery: DeliveryAttempt }>(
			'/api/notifications/deliveries/replay',
			{ id },
			csrfToken,
		)
	).delivery;
}
