import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	createWebhook,
	deleteWebhook,
	disableWebhook,
	loadDeliveries,
	loadInbox,
	loadUnreadCount,
	markInboxRead,
	NotificationsApiError,
	notificationsErrorMessage,
	replayDelivery,
	savePreference,
} from '../src/client/api.ts';

function ok(body: unknown, status = 200): () => Promise<Response> {
	return async () => Response.json(body as Record<string, unknown>, { status });
}

function failing(
	code: string,
	message: string,
	status: number,
): () => Promise<Response> {
	return async () => Response.json({ error: { code, message } }, { status });
}

function requestOf(mock: ReturnType<typeof vi.fn>, call = 0) {
	const [path, init] = mock.mock.calls[call] as [string, RequestInit];
	return { path, init, headers: new Headers(init?.headers) };
}

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'notifications.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

afterEach(() => {
	setActiveLocale('en');
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('notifications inbox client', () => {
	it('asks for the whole inbox when no filter is set', async () => {
		const fetchMock = vi.fn(ok({ inbox: [] }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(loadInbox()).resolves.toEqual([]);
		expect(requestOf(fetchMock).path).toBe('/api/notifications/inbox');
	});

	it('carries only the filters the reader chose', async () => {
		const fetchMock = vi.fn(ok({ inbox: [] }));
		vi.stubGlobal('fetch', fetchMock);

		await loadInbox({ status: 'unread', kind: '' });
		expect(requestOf(fetchMock).path).toBe(
			'/api/notifications/inbox?status=unread',
		);

		await loadInbox({ status: 'archived', kind: 'agent-run-failed' });
		expect(requestOf(fetchMock, 1).path).toBe(
			'/api/notifications/inbox?status=archived&kind=agent-run-failed',
		);
	});

	it('reads the unread count the badge shows', async () => {
		vi.stubGlobal('fetch', vi.fn(ok({ unread: 7 })));
		await expect(loadUnreadCount()).resolves.toBe(7);
	});

	it('proves the session on every inbox mutation', async () => {
		const fetchMock = vi.fn(ok({ item: { id: 'item-1', status: 'read' } }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(markInboxRead('item-1', 'csrf-value')).resolves.toEqual({
			id: 'item-1',
			status: 'read',
		});
		const request = requestOf(fetchMock);
		expect(request.path).toBe('/api/notifications/inbox/mark-read');
		expect(request.init.method).toBe('POST');
		expect(request.init.credentials).toBe('same-origin');
		expect(request.init.body).toBe(JSON.stringify({ id: 'item-1' }));
		expect(request.headers.get('x-csrf-token')).toBe('csrf-value');
	});

	it('saves one preference kind at a time', async () => {
		const fetchMock = vi.fn(
			ok({ preference: { kind: 'agent-run-failed', enabled: false } }),
		);
		vi.stubGlobal('fetch', fetchMock);

		await savePreference('agent-run-failed', false, 'csrf-value');
		const request = requestOf(fetchMock);
		expect(request.path).toBe('/api/notifications/preferences/save');
		expect(request.init.body).toBe(
			JSON.stringify({ kind: 'agent-run-failed', enabled: false }),
		);
		expect(request.headers.get('x-csrf-token')).toBe('csrf-value');
	});
});

describe('notifications webhook client', () => {
	it('returns the secret the create response carries once', async () => {
		const fetchMock = vi.fn(
			ok(
				{
					subscription: { id: 'sub-1', name: 'Billing' },
					secret: 'whsec-once',
				},
				201,
			),
		);
		vi.stubGlobal('fetch', fetchMock);

		const created = await createWebhook(
			{
				name: 'Billing',
				url: 'https://example.com/hook',
				events: ['agent-run-failed'],
				description: null,
			},
			'csrf-value',
		);
		expect(created.secret).toBe('whsec-once');
		const request = requestOf(fetchMock);
		expect(request.path).toBe('/api/notifications/webhooks');
		expect(request.init.body).toBe(
			JSON.stringify({
				name: 'Billing',
				url: 'https://example.com/hook',
				events: ['agent-run-failed'],
				description: null,
			}),
		);
		expect(request.headers.get('x-csrf-token')).toBe('csrf-value');
	});

	it('addresses each lifecycle action to its own endpoint', async () => {
		const fetchMock = vi.fn(
			ok({ subscription: { id: 'sub-1', status: 'disabled' } }),
		);
		vi.stubGlobal('fetch', fetchMock);

		await disableWebhook('sub-1', 'csrf-value');
		expect(requestOf(fetchMock).path).toBe(
			'/api/notifications/webhooks/disable',
		);

		vi.stubGlobal('fetch', vi.fn(ok({ deleted: 'sub-1' })));
		await deleteWebhook('sub-1', 'csrf-value');
	});
});

describe('notifications delivery client', () => {
	it('filters the ledger by status and subscription', async () => {
		const fetchMock = vi.fn(ok({ deliveries: [] }));
		vi.stubGlobal('fetch', fetchMock);

		await loadDeliveries({ status: 'dead-letter', subscriptionId: 'sub-1' });
		expect(requestOf(fetchMock).path).toBe(
			'/api/notifications/deliveries?status=dead-letter&subscription=sub-1',
		);
	});

	it('accepts the queued replay the server answers with 202', async () => {
		const fetchMock = vi.fn(
			ok({ delivery: { id: 'delivery-2', status: 'pending' } }, 202),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(replayDelivery('delivery-1', 'csrf-value')).resolves.toEqual({
			id: 'delivery-2',
			status: 'pending',
		});
		expect(requestOf(fetchMock).path).toBe(
			'/api/notifications/deliveries/replay',
		);
	});
});

describe('notifications error mapping', () => {
	it('keeps the server code and status on a rejected request', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				failing(
					'SUBSCRIPTION_NAME_CONFLICT',
					'A webhook subscription with this name already exists.',
					409,
				),
			),
		);

		const error = await createWebhook(
			{
				name: 'Billing',
				url: 'https://example.com/hook',
				events: ['agent-run-failed'],
				description: null,
			},
			'csrf-value',
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NotificationsApiError);
		expect((error as NotificationsApiError).code).toBe(
			'SUBSCRIPTION_NAME_CONFLICT',
		);
		expect((error as NotificationsApiError).status).toBe(409);
	});

	it('translates a known code in every locale', () => {
		const conflict = new NotificationsApiError(
			409,
			'SUBSCRIPTION_NAME_CONFLICT',
			'A webhook subscription with this name already exists.',
		);
		expect(
			notificationsErrorMessage(conflict, 'notifications.error.request'),
		).toBe('Another subscription in this workspace already uses this name.');
		setActiveLocale('pl');
		expect(
			notificationsErrorMessage(conflict, 'notifications.error.request'),
		).toBe('Inna subskrypcja w tym obszarze roboczym używa już tej nazwy.');
	});

	it('keeps the server sentence for a code this module does not know', () => {
		const unknown = new NotificationsApiError(
			400,
			'SOME_NEW_SERVER_CODE',
			'The delivery loop refused the request.',
		);
		expect(
			notificationsErrorMessage(unknown, 'notifications.error.request'),
		).toBe('The delivery loop refused the request.');
	});

	it('falls back to the screen copy when the failure carries no message', () => {
		expect(
			notificationsErrorMessage(
				{ broken: true },
				'notifications.inbox.error.load',
			),
		).toBe('Could not load your notifications.');
	});
});
