import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { NOTIFICATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness } from './support/harness.ts';

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

describe('notifications.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('notifications.core');
		expect(moduleDefinition.permissions).toEqual([
			'notifications.inbox.read',
			'notifications.inbox.manage',
			'notifications.webhooks.read',
			'notifications.webhooks.manage',
			'notifications.deliveries.read',
		]);
		for (const permission of Object.values(NOTIFICATIONS_PERMISSIONS)) {
			expect(permission).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
		}
	});

	it('isolates inbox items by trusted tenant id', async () => {
		const { publisher, inbox } = createHarness({
			repository: shared.repository,
		});
		await publisher.publish({
			tenantId: 'tenant-a',
			kind: 'agent-run-completed',
			sourceModule: 'agents.core',
			sourceRef: 'run-shared',
			title: 'Alpha',
			recipients: ['account-shared'],
		});
		await publisher.publish({
			tenantId: 'tenant-b',
			kind: 'agent-run-completed',
			sourceModule: 'agents.core',
			sourceRef: 'run-shared',
			title: 'Beta',
			recipients: ['account-shared'],
		});

		expect(
			(await inbox.list('tenant-a', 'account-shared')).map((i) => i.title),
		).toEqual(['Alpha']);
		expect(
			(await inbox.list('tenant-b', 'account-shared')).map((i) => i.title),
		).toEqual(['Beta']);
	});
});
