import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NotificationsServiceError } from '../src/services/service-error.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness } from './support/harness.ts';

const TENANT = 'tenant-inbox';

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function harness() {
	return createHarness({ repository: shared.repository });
}

async function seed() {
	const { publisher, inbox } = harness();
	await publisher.publish({
		tenantId: TENANT,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef: 'run-ada',
		title: 'For Ada',
		recipients: ['account-ada'],
	});
	await publisher.publish({
		tenantId: TENANT,
		kind: 'workflow-run-failed',
		sourceModule: 'workflows.core',
		sourceRef: 'run-bo',
		title: 'For Bo',
		recipients: ['account-bo'],
	});
	const ada = (await inbox.list(TENANT, 'account-ada'))[0]!;
	const bo = (await inbox.list(TENANT, 'account-bo'))[0]!;
	return { inbox, ada, bo };
}

describe('notifications inbox ownership', () => {
	it('NOTIFICATIONS-INBOX-OWN lists only the items addressed to the calling member', async () => {
		const { inbox } = await seed();
		expect(
			(await inbox.list(TENANT, 'account-ada')).map((i) => i.title),
		).toEqual(['For Ada']);
		expect(
			(await inbox.list(TENANT, 'account-bo')).map((i) => i.title),
		).toEqual(['For Bo']);
	});

	it('NOTIFICATIONS-INBOX-OWN answers not found for another member item on every mutation', async () => {
		const { inbox, bo } = await seed();
		for (const mutate of [
			() => inbox.markRead(TENANT, 'account-ada', bo.id),
			() => inbox.markUnread(TENANT, 'account-ada', bo.id),
			() => inbox.archive(TENANT, 'account-ada', bo.id),
		]) {
			await expect(mutate()).rejects.toMatchObject({
				code: 'INBOX_ITEM_NOT_FOUND',
				status: 404,
			});
		}
		expect((await inbox.list(TENANT, 'account-bo'))[0]?.status).toBe('unread');
	});

	it('NOTIFICATIONS-INBOX-OWN filters by status and kind for the member only', async () => {
		const { inbox, ada } = await seed();
		await inbox.markRead(TENANT, 'account-ada', ada.id);
		expect(
			await inbox.list(TENANT, 'account-ada', { status: 'unread' }),
		).toHaveLength(0);
		expect(
			await inbox.list(TENANT, 'account-ada', { status: 'read' }),
		).toHaveLength(1);
		expect(
			await inbox.list(TENANT, 'account-ada', { kind: 'workflow-run-failed' }),
		).toHaveLength(0);
	});

	it('marks read, unread and archived and keeps the unread count in step', async () => {
		const { inbox, ada } = await seed();
		expect(await inbox.unreadCount(TENANT, 'account-ada')).toBe(1);

		const read = await inbox.markRead(TENANT, 'account-ada', ada.id);
		expect(read.status).toBe('read');
		expect(read.readAt).not.toBeNull();
		expect(await inbox.unreadCount(TENANT, 'account-ada')).toBe(0);

		const unread = await inbox.markUnread(TENANT, 'account-ada', ada.id);
		expect(unread.status).toBe('unread');
		expect(unread.readAt).toBeNull();
		expect(await inbox.unreadCount(TENANT, 'account-ada')).toBe(1);

		const archived = await inbox.archive(TENANT, 'account-ada', ada.id);
		expect(archived.status).toBe('archived');
		expect(await inbox.unreadCount(TENANT, 'account-ada')).toBe(0);
		expect(
			await inbox.list(TENANT, 'account-ada', { status: 'archived' }),
		).toHaveLength(1);
	});

	it('repeats a transition without changing anything further', async () => {
		const { inbox, ada } = await seed();
		const first = await inbox.markRead(TENANT, 'account-ada', ada.id);
		const second = await inbox.markRead(TENANT, 'account-ada', ada.id);
		expect(second.status).toBe(first.status);
		expect(await inbox.unreadCount(TENANT, 'account-ada')).toBe(0);
	});

	it('saves one preference row per member and kind', async () => {
		const { inbox } = harness();
		await inbox.savePreference(
			TENANT,
			'account-ada',
			'agent-run-failed',
			false,
		);
		await inbox.savePreference(TENANT, 'account-ada', 'agent-run-failed', true);
		const preferences = await inbox.listPreferences(TENANT, 'account-ada');
		expect(preferences).toHaveLength(1);
		expect(preferences[0]?.enabled).toBe(true);
		expect(await inbox.listPreferences(TENANT, 'account-bo')).toHaveLength(0);
	});

	it('rejects an unknown kind before touching the store', async () => {
		const { inbox } = harness();
		await expect(
			inbox.savePreference(TENANT, 'account-ada', 'nope' as never, true),
		).rejects.toBeInstanceOf(NotificationsServiceError);
		expect(await inbox.listPreferences(TENANT, 'account-ada')).toHaveLength(0);
	});
});
