import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { NOTIFICATIONS_PERMISSIONS } from '../acl/permissions.ts';
import {
	DELIVERY_STATUSES,
	INBOX_STATUSES,
	NOTIFICATION_KINDS,
	type DeliveryStatus,
	type NotificationKind,
	type NotificationsInboxStatus,
} from '../domain/types.ts';
import type { NotificationsRuntime } from '../server/runtime.ts';
import { NotificationsServiceError } from '../services/service-error.ts';

function failure(error: unknown): Response {
	if (error instanceof NotificationsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The notifications operation failed.');
}

function bodyOneOf<T extends string>(
	value: Record<string, unknown>,
	key: string,
	values: readonly T[],
): T {
	const text = requiredString(value, key, { max: 64 });
	if (!(values as readonly string[]).includes(text)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be one of: ${values.join(', ')}.`,
			400,
		);
	}
	return text as T;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
	const result = value[key];
	if (typeof result !== 'boolean') {
		throw new HttpProblem('INVALID_INPUT', `${key} must be a boolean.`, 400);
	}
	return result;
}

function requiredKinds(
	value: Record<string, unknown>,
	key: string,
): readonly string[] {
	const result = value[key];
	if (
		!Array.isArray(result) ||
		result.length === 0 ||
		result.length > NOTIFICATION_KINDS.length ||
		result.some((entry) => typeof entry !== 'string')
	) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be an array of 1 to ${NOTIFICATION_KINDS.length} event kinds.`,
			400,
		);
	}
	return result as readonly string[];
}

function optionalText(
	value: Record<string, unknown>,
	key: string,
	max: number,
): string | null {
	const result = value[key];
	if (result === undefined || result === null || result === '') return null;
	return requiredString(value, key, { max });
}

/* A query filter is optional; an unknown value is a rejection rather than a
   silently ignored parameter. */
function queryOneOf<T extends string>(
	request: Request,
	key: string,
	values: readonly T[],
): T | undefined {
	const raw = new URL(request.url).searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (!(values as readonly string[]).includes(raw)) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must be one of: ${values.join(', ')}.`,
			400,
		);
	}
	return raw as T;
}

function queryIdentifier(request: Request, key: string): string | undefined {
	const raw = new URL(request.url).searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (raw.length > 128) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too long.`, 400);
	}
	return raw;
}

export function createNotificationsRoutes(
	auth: AuthRuntime,
	runtime: NotificationsRuntime,
) {
	const listInbox = defineEndpoint({
		id: 'notifications.inbox.list',
		path: '/api/notifications/inbox',
		methods: ['GET'],
		access: { kind: 'permission', permission: NOTIFICATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					inbox: await service.list(principal.tenantId, principal.accountId, {
						status: queryOneOf<NotificationsInboxStatus>(
							octane.request,
							'status',
							INBOX_STATUSES,
						),
						kind: queryOneOf<NotificationKind>(
							octane.request,
							'kind',
							NOTIFICATION_KINDS,
						),
					}),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const unreadCount = defineEndpoint({
		id: 'notifications.inbox.unread',
		path: '/api/notifications/inbox/unread-count',
		methods: ['GET'],
		access: { kind: 'permission', permission: NOTIFICATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			const service = await runtime.service();
			return jsonResponse({
				unread: await service.unreadCount(
					principal.tenantId,
					principal.accountId,
				),
			});
		},
	});

	const inboxTransition = (
		id: string,
		path: string,
		apply: (
			tenantId: string,
			accountId: string,
			itemId: string,
		) => Promise<unknown>,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: {
				kind: 'permission',
				permission: NOTIFICATIONS_PERMISSIONS.manage,
			},
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					const principal = principalFromContext(octane)!;
					return jsonResponse({
						item: await apply(
							principal.tenantId,
							principal.accountId,
							requiredString(value, 'id', { max: 128 }),
						),
					});
				} catch (error) {
					return failure(error);
				}
			},
		});

	const markRead = inboxTransition(
		'notifications.inbox.mark-read',
		'/api/notifications/inbox/mark-read',
		async (tenantId, accountId, itemId) =>
			(await runtime.service()).markRead(tenantId, accountId, itemId),
	);
	const markUnread = inboxTransition(
		'notifications.inbox.mark-unread',
		'/api/notifications/inbox/mark-unread',
		async (tenantId, accountId, itemId) =>
			(await runtime.service()).markUnread(tenantId, accountId, itemId),
	);
	const archive = inboxTransition(
		'notifications.inbox.archive',
		'/api/notifications/inbox/archive',
		async (tenantId, accountId, itemId) =>
			(await runtime.service()).archive(tenantId, accountId, itemId),
	);

	const listPreferences = defineEndpoint({
		id: 'notifications.preferences.list',
		path: '/api/notifications/preferences',
		methods: ['GET'],
		access: { kind: 'permission', permission: NOTIFICATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const principal = principalFromContext(octane)!;
			const service = await runtime.service();
			return jsonResponse({
				kinds: NOTIFICATION_KINDS,
				preferences: await service.listPreferences(
					principal.tenantId,
					principal.accountId,
				),
			});
		},
	});

	const savePreference = defineEndpoint({
		id: 'notifications.preferences.save',
		path: '/api/notifications/preferences/save',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.manage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				return jsonResponse({
					preference: await service.savePreference(
						principal.tenantId,
						principal.accountId,
						bodyOneOf<NotificationKind>(value, 'kind', NOTIFICATION_KINDS),
						requiredBoolean(value, 'enabled'),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const listWebhooks = defineEndpoint({
		id: 'notifications.webhooks.list',
		path: '/api/notifications/webhooks',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.webhooksRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const service = await runtime.webhooks();
			return jsonResponse({
				subscriptions: await service.list(
					principalFromContext(octane)!.tenantId,
				),
			});
		},
	});

	const createWebhook = defineEndpoint({
		id: 'notifications.webhooks.create',
		path: '/api/notifications/webhooks',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.webhooksManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.webhooks();
				const created = await service.create(
					principal.tenantId,
					principal.accountId,
					{
						name: requiredString(value, 'name', { max: 120 }),
						url: requiredString(value, 'url', { max: 2_048 }),
						events: requiredKinds(value, 'events'),
						description: optionalText(value, 'description', 1_000),
					},
				);
				/* The only response that ever carries the secret. */
				return jsonResponse(created, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const updateWebhook = defineEndpoint({
		id: 'notifications.webhooks.update',
		path: '/api/notifications/webhooks/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.webhooksManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.webhooks();
				return jsonResponse({
					subscription: await service.update(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'id', { max: 128 }),
						{
							name: requiredString(value, 'name', { max: 120 }),
							url: requiredString(value, 'url', { max: 2_048 }),
							events: requiredKinds(value, 'events'),
							description: optionalText(value, 'description', 1_000),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const webhookAction = (
		id: string,
		path: string,
		apply: (tenantId: string, subscriptionId: string) => Promise<unknown>,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: {
				kind: 'permission',
				permission: NOTIFICATIONS_PERMISSIONS.webhooksManage,
			},
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const value = await readJsonObject(octane.request);
					return jsonResponse(
						await apply(
							principalFromContext(octane)!.tenantId,
							requiredString(value, 'id', { max: 128 }),
						),
					);
				} catch (error) {
					return failure(error);
				}
			},
		});

	const pauseWebhook = webhookAction(
		'notifications.webhooks.pause',
		'/api/notifications/webhooks/pause',
		async (tenantId, id) => ({
			subscription: await (await runtime.webhooks()).pause(tenantId, id),
		}),
	);
	const resumeWebhook = webhookAction(
		'notifications.webhooks.resume',
		'/api/notifications/webhooks/resume',
		async (tenantId, id) => ({
			subscription: await (await runtime.webhooks()).resume(tenantId, id),
		}),
	);
	const disableWebhook = webhookAction(
		'notifications.webhooks.disable',
		'/api/notifications/webhooks/disable',
		async (tenantId, id) => ({
			subscription: await (await runtime.webhooks()).disable(tenantId, id),
		}),
	);
	const rotateWebhookSecret = webhookAction(
		'notifications.webhooks.rotate-secret',
		'/api/notifications/webhooks/rotate-secret',
		/* The second and last response that carries a secret. */
		async (tenantId, id) =>
			(await runtime.webhooks()).rotateSecret(tenantId, id),
	);
	const deleteWebhook = webhookAction(
		'notifications.webhooks.delete',
		'/api/notifications/webhooks/delete',
		async (tenantId, id) => {
			await (await runtime.webhooks()).delete(tenantId, id);
			return { deleted: id };
		},
	);

	const listDeliveries = defineEndpoint({
		id: 'notifications.deliveries.list',
		path: '/api/notifications/deliveries',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.deliveriesRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.deliveries();
				return jsonResponse({
					deliveries: await service.list(
						principalFromContext(octane)!.tenantId,
						{
							status: queryOneOf<DeliveryStatus>(
								octane.request,
								'status',
								DELIVERY_STATUSES,
							),
							subscriptionId: queryIdentifier(octane.request, 'subscription'),
						},
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const replayDelivery = defineEndpoint({
		id: 'notifications.deliveries.replay',
		path: '/api/notifications/deliveries/replay',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: NOTIFICATIONS_PERMISSIONS.deliveriesRead,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.deliveries();
				return jsonResponse(
					{
						delivery: await service.replay(
							principalFromContext(octane)!.tenantId,
							requiredString(value, 'id', { max: 128 }),
						),
					},
					202,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		listInbox.serverRoute,
		unreadCount.serverRoute,
		markRead.serverRoute,
		markUnread.serverRoute,
		archive.serverRoute,
		listPreferences.serverRoute,
		savePreference.serverRoute,
		listWebhooks.serverRoute,
		createWebhook.serverRoute,
		updateWebhook.serverRoute,
		pauseWebhook.serverRoute,
		resumeWebhook.serverRoute,
		disableWebhook.serverRoute,
		rotateWebhookSecret.serverRoute,
		deleteWebhook.serverRoute,
		listDeliveries.serverRoute,
		replayDelivery.serverRoute,
	] as const;
}

export const endpoints = [
	'notifications.inbox.list',
	'notifications.inbox.unread',
	'notifications.inbox.mark-read',
	'notifications.inbox.mark-unread',
	'notifications.inbox.archive',
	'notifications.preferences.list',
	'notifications.preferences.save',
	'notifications.webhooks.list',
	'notifications.webhooks.create',
	'notifications.webhooks.update',
	'notifications.webhooks.pause',
	'notifications.webhooks.resume',
	'notifications.webhooks.disable',
	'notifications.webhooks.rotate-secret',
	'notifications.webhooks.delete',
	'notifications.deliveries.list',
	'notifications.deliveries.replay',
] as const;
