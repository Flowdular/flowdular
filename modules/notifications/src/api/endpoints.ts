import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
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
	INBOX_TRANSITION_MANY_LIMIT,
	INBOX_TRANSITIONS,
	NOTIFICATION_KINDS,
	SUBSCRIPTION_STATUSES,
	type DeliveryStatus,
	type InboxTransition,
	type NotificationKind,
	type NotificationsInboxStatus,
	type WebhookSubscriptionStatus,
} from '../domain/types.ts';
import type { NotificationsRuntime } from '../server/runtime.ts';
import { DELIVERY_SEARCH_MAX } from '../services/delivery-service.ts';
import {
	LIST_PAGE_DEFAULT,
	LIST_PAGE_LIMIT,
	textKey,
	timeKey,
	type ListPageInput,
	type ListResult,
} from '../services/paging.ts';
import type { PageDirection } from '../services/repository.ts';
import { NotificationsServiceError } from '../services/service-error.ts';
import {
	SUBSCRIPTION_NAME_MAX,
	SUBSCRIPTION_SEARCH_MAX,
} from '../services/webhook-service.ts';

const DIRECTIONS: readonly PageDirection[] = ['asc', 'desc'];

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

/* The bounds are checked here so a list that is too long never reaches the
   store; the service checks them again for any other caller. */
function requiredIds(
	value: Record<string, unknown>,
	key: string,
): readonly string[] {
	const raw = value[key];
	if (!Array.isArray(raw)) {
		throw new HttpProblem('INVALID_INPUT', `${key} must be an array.`, 400);
	}
	if (raw.length < 1 || raw.length > INBOX_TRANSITION_MANY_LIMIT) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must name between 1 and ${INBOX_TRANSITION_MANY_LIMIT} items.`,
			400,
		);
	}
	const ids = raw.map((entry) =>
		requiredString({ id: entry }, 'id', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`${key} must not repeat an id.`,
			400,
		);
	}
	return ids;
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

function queryText(
	request: Request,
	key: string,
	max: number,
): string | undefined {
	const raw = new URL(request.url).searchParams.get(key);
	if (raw === null || raw.trim() === '') return undefined;
	if (raw.length > max) {
		throw new HttpProblem('INVALID_INPUT', `${key} is too long.`, 400);
	}
	return raw;
}

function invalidCursor(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

interface ListQueryOptions<Sort extends string, Key extends string | number> {
	readonly sorts: readonly Sort[];
	readonly defaultSort: Sort;
	readonly defaultDirection: PageDirection;
	/**
	 * What a cursor is bound to besides its position: the tenant, the member
	 * where the list is theirs, and every filter. A cursor made under a
	 * different binding names a position in a different list.
	 */
	readonly binding: Readonly<Record<string, string>>;
	/** Reads the cursor key back under the sort's type; throws on anything else. */
	readonly key: (value: unknown) => Key;
}

interface ListQuery<Key extends string | number> {
	readonly page: ListPageInput<Key>;
	readonly respond: <Item>(result: ListResult<Item, Key>) => Response;
}

/**
 * The `limit`, `cursor`, `sort` and `direction` of a list request, and the
 * page response that hands the next cursor back. The cursor carries the sort,
 * the direction and the binding it was made under; a request that differs on
 * any of them is refused rather than answered with a page of another list.
 */
function listQuery<Sort extends string, Key extends string | number>(
	request: Request,
	secret: Uint8Array,
	options: ListQueryOptions<Sort, Key>,
): ListQuery<Key> {
	const url = new URL(request.url);
	const paging = readPageQuery(url, {
		maxLimit: LIST_PAGE_LIMIT,
		defaultLimit: LIST_PAGE_DEFAULT,
	});
	const sort =
		queryOneOf(request, 'sort', options.sorts) ?? options.defaultSort;
	const direction =
		queryOneOf(request, 'direction', DIRECTIONS) ?? options.defaultDirection;
	const bound = new URLSearchParams(options.binding).toString();
	let after: { readonly key: Key; readonly id: string } | null = null;
	if (paging.cursor !== null) {
		const payload = decodeCursor(paging.cursor, secret);
		if (
			payload.b !== bound ||
			payload.s !== sort ||
			payload.d !== direction ||
			typeof payload.id !== 'string'
		) {
			throw invalidCursor();
		}
		try {
			after = { key: options.key(payload.k), id: payload.id };
		} catch {
			throw invalidCursor();
		}
	}
	return {
		page: { limit: paging.limit, direction, after },
		respond: (result) =>
			pageResponse({
				items: result.items,
				limit: paging.limit,
				/* A full page may still be the last one; the client stops when the
				   cursor stops, which costs one empty page at most. */
				nextCursor:
					result.next === null
						? null
						: encodeCursor(
								{
									b: bound,
									s: sort,
									d: direction,
									k: result.next.key,
									id: result.next.id,
								},
								secret,
							),
			}),
	};
}

/* A subscription page resumes from a normalized name. */
function nameKey(value: unknown): string {
	return textKey(value, SUBSCRIPTION_NAME_MAX);
}

export function createNotificationsRoutes(
	auth: AuthRuntime,
	runtime: NotificationsRuntime,
) {
	/* Module-owned and never stored: a cursor names a position in one list, so
	   a restart invalidating one costs a client the first page. */
	const cursorSecret = randomBytes(32);

	const listInbox = defineEndpoint({
		id: 'notifications.inbox.list',
		path: '/api/notifications/inbox',
		methods: ['GET'],
		access: { kind: 'permission', permission: NOTIFICATIONS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const filters = {
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
				};
				const query = listQuery(octane.request, cursorSecret, {
					sorts: ['createdAt'],
					defaultSort: 'createdAt',
					defaultDirection: 'desc',
					binding: {
						t: principal.tenantId,
						a: principal.accountId,
						status: filters.status ?? '',
						kind: filters.kind ?? '',
					},
					key: timeKey,
				});
				const service = await runtime.service();
				return query.respond(
					await service.listPage(
						principal.tenantId,
						principal.accountId,
						filters,
						query.page,
					),
				);
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

	/* Many of the member's own items in one call, each through the single
	   transition path above, so the permission, the CSRF proof and the recipient
	   scope are exactly those of one item. */
	const transitionMany = defineEndpoint({
		id: 'notifications.inbox.transition-many',
		path: '/api/notifications/inbox/transition-many',
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
					outcomes: await service.transitionMany(
						principal.tenantId,
						principal.accountId,
						requiredIds(value, 'ids'),
						bodyOneOf<InboxTransition>(value, 'transition', INBOX_TRANSITIONS),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

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
				member: await service.memberSettings(
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

	/* The workspace-wide switch of the signed-in member. It is a preference of
	   their own account, so it carries the same permission as the per-kind one
	   and reads the account from the principal. */
	const saveEmailDelivery = defineEndpoint({
		id: 'notifications.preferences.email',
		path: '/api/notifications/preferences/email',
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
					member: await service.saveEmailDelivery(
						principal.tenantId,
						principal.accountId,
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
			try {
				const tenantId = principalFromContext(octane)!.tenantId;
				const filters = {
					status: queryOneOf<WebhookSubscriptionStatus>(
						octane.request,
						'status',
						SUBSCRIPTION_STATUSES,
					),
					search: queryText(octane.request, 'q', SUBSCRIPTION_SEARCH_MAX),
				};
				const query = listQuery(octane.request, cursorSecret, {
					sorts: ['name'],
					defaultSort: 'name',
					defaultDirection: 'asc',
					binding: {
						t: tenantId,
						status: filters.status ?? '',
						q: filters.search ?? '',
					},
					key: nameKey,
				});
				const service = await runtime.webhooks();
				return query.respond(
					await service.listPage(tenantId, filters, query.page),
				);
			} catch (error) {
				return failure(error);
			}
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
				const tenantId = principalFromContext(octane)!.tenantId;
				const filters = {
					status: queryOneOf<DeliveryStatus>(
						octane.request,
						'status',
						DELIVERY_STATUSES,
					),
					subscriptionId: queryText(octane.request, 'subscription', 128),
					search: queryText(octane.request, 'q', DELIVERY_SEARCH_MAX),
				};
				const query = listQuery(octane.request, cursorSecret, {
					sorts: ['scheduledFor'],
					defaultSort: 'scheduledFor',
					defaultDirection: 'desc',
					binding: {
						t: tenantId,
						status: filters.status ?? '',
						subscription: filters.subscriptionId ?? '',
						q: filters.search ?? '',
					},
					key: timeKey,
				});
				const service = await runtime.deliveries();
				return query.respond(
					await service.listPage(tenantId, filters, query.page),
				);
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
		transitionMany.serverRoute,
		listPreferences.serverRoute,
		savePreference.serverRoute,
		saveEmailDelivery.serverRoute,
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
	'notifications.inbox.transition-many',
	'notifications.preferences.list',
	'notifications.preferences.save',
	'notifications.preferences.email',
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
