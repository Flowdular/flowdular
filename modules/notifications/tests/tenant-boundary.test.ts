import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	NOTIFICATIONS_TENANT_TABLES,
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness, publicResolver } from './support/harness.ts';

const RESOLVER = publicResolver({ 'hooks.example': '93.184.216.34' });

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
	return createHarness({ repository: shared.repository, resolve: RESOLVER });
}

async function seedTenant(tenantId: string, sourceRef: string) {
	const { webhooks, publisher } = harness();
	await webhooks.create(tenantId, 'account-owner', {
		name: `Receiver ${tenantId}`,
		url: 'https://hooks.example/receiver',
		events: ['agent-run-failed'],
	});
	await publisher.publish({
		tenantId,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef,
		title: `Event for ${tenantId}`,
		recipients: [`member-${tenantId}`],
	});
}

describe('notifications tenant boundary', () => {
	it('NOTIFICATIONS-TENANT-BOUNDARY shows one tenant only its own inbox, subscriptions and deliveries', async () => {
		await seedTenant('tenant-alpha', 'run-alpha');
		await seedTenant('tenant-beta', 'run-beta');
		const { inbox, webhooks, deliveries } = harness();

		expect(
			(await inbox.list('tenant-alpha', 'member-tenant-alpha')).map(
				(item) => item.sourceRef,
			),
		).toEqual(['run-alpha']);
		expect(await inbox.list('tenant-alpha', 'member-tenant-beta')).toHaveLength(
			0,
		);
		expect((await webhooks.list('tenant-alpha')).map((s) => s.name)).toEqual([
			'Receiver tenant-alpha',
		]);
		expect(
			(await deliveries.list('tenant-beta', {})).map(
				(entry) => entry.sourceRef,
			),
		).toEqual(['run-beta']);
	});

	it('NOTIFICATIONS-TENANT-BOUNDARY rejects a row carrying another tenant identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO notifications_inbox
						 (id, tenant_id, recipient_account_id, kind, title, body,
						  source_module, source_ref, status, read_at, created_at)
						 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, NULL, $9)`,
						parameters: [
							'smuggled',
							'tenant-beta',
							'member-tenant-beta',
							'agent-run-failed',
							'Smuggled',
							'agents.core',
							'run-smuggled',
							'unread',
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-alpha' },
			),
		).rejects.toThrow();
	});

	/* The switch is keyed by (tenant, account), and one person is a member of
	   several workspaces under the same account id: what they asked for in one
	   must not decide what the other workspace mails them. */
	it('NOTIFICATIONS-TENANT-BOUNDARY keeps a member e-mail switch inside its own workspace', async () => {
		const { inbox } = harness();
		await inbox.saveEmailDelivery('tenant-alpha', 'member-shared', true, 1_000);

		expect(
			await inbox.memberSettings('tenant-beta', 'member-shared'),
		).toMatchObject({ emailDelivery: false });
		await inbox.saveEmailDelivery('tenant-beta', 'member-shared', false, 2_000);
		expect(
			await inbox.memberSettings('tenant-alpha', 'member-shared'),
		).toMatchObject({ emailDelivery: true });

		/* A statement naming another workspace is refused by the policy rather
		   than silently writing there, and one that names none reaches only the
		   rows of the workspace it runs under. */
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO notifications_member_preferences
						 (tenant_id, recipient_account_id, email_delivery, created_at, updated_at)
						 VALUES ($1, $2, 1, $3, $3)`,
						parameters: ['tenant-beta', 'member-smuggled', 3_000],
					}),
				{ access: 'write', tenantId: 'tenant-alpha' },
			),
		).rejects.toThrow();
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: 'UPDATE notifications_member_preferences SET email_delivery = 0',
				}),
			{ access: 'write', tenantId: 'tenant-beta' },
		);

		expect(
			await inbox.memberSettings('tenant-alpha', 'member-shared'),
		).toMatchObject({ emailDelivery: true });
	});

	it('NOTIFICATIONS-TENANT-BOUNDARY lets the poll read routing columns only, across tenants', async () => {
		await seedTenant('tenant-alpha', 'run-alpha');
		await seedTenant('tenant-beta', 'run-beta');

		const routing = await shared.repository.listDueDeliveries(
			Date.now() + 1_000,
			10,
		);
		expect([...new Set(routing.map((entry) => entry.tenantId))].sort()).toEqual(
			['tenant-alpha', 'tenant-beta'],
		);
		expect(Object.keys(routing[0] ?? {}).sort()).toEqual([
			'id',
			'scheduledFor',
			'status',
			'tenantId',
		]);

		await expect(
			shared.background.query({
				text: 'SELECT payload_digest FROM notifications_deliveries LIMIT 1',
			}),
		).rejects.toThrow();
		await expect(
			shared.background.query({
				text: 'SELECT source_ref FROM notifications_deliveries LIMIT 1',
			}),
		).rejects.toThrow();
	});

	it('NOTIFICATIONS-TENANT-BOUNDARY lets the rotation inventory read the tenant and the key id only', async () => {
		await seedTenant('tenant-alpha', 'run-alpha');

		const inventory = await shared.background.query<{ tenant_id: string }>({
			text: `SELECT tenant_id, secret_key_id
			 FROM notifications_webhook_subscriptions`,
		});
		expect(inventory.rows.map((row) => row.tenant_id)).toEqual([
			'tenant-alpha',
		]);

		for (const column of [
			'secret_ciphertext',
			'secret_iv',
			'secret_tag',
			'secret_fingerprint',
			'url',
		]) {
			await expect(
				shared.background.query({
					text: `SELECT ${column} FROM notifications_webhook_subscriptions LIMIT 1`,
				}),
			).rejects.toThrow();
		}
	});

	it('NOTIFICATIONS-TENANT-BOUNDARY keeps every table no migration granted away from the background role', async () => {
		/* The two tables the background role reads say so in their own migration:
		   the delivery routing columns and the subscription key inventory. */
		const granted = new Set([
			'notifications_deliveries',
			'notifications_webhook_subscriptions',
		]);
		for (const table of NOTIFICATIONS_TENANT_TABLES.filter(
			(name) => !granted.has(name),
		)) {
			await expect(
				shared.background.query({ text: `SELECT 1 FROM ${table} LIMIT 1` }),
			).rejects.toThrow();
		}
	});
});
