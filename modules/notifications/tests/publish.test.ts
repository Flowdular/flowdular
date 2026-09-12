import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseQueryResult,
	DatabaseRow,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { NOTIFICATIONS_PUBLISH_CAPABILITY } from '../src/domain/publish.ts';
import { DatabaseNotificationsRepository } from '../src/services/database-repository.ts';
import { NotificationPublishService } from '../src/services/publish-service.ts';
import { NotificationsServiceError } from '../src/services/service-error.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness, publicResolver } from './support/harness.ts';

const TENANT = 'tenant-publish';
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

/**
 * The loser of two publications of one event. At READ COMMITTED its idempotency
 * read runs before the winner commits, so it finds nothing, and the inserts that
 * follow are the ones that hit the unique indexes. One engine cannot interleave
 * two transactions, so the loser's first read is blinded instead: everything
 * after it, the conflicting inserts included, is the real path.
 */
function blindFirstIdempotencyRead(handle: DatabaseHandle): {
	readonly publisher: NotificationPublishService;
	blinded(): number;
} {
	let blinded = 0;
	const blind = (statement: DatabaseStatement): boolean => {
		const target =
			statement.text.startsWith('SELECT id FROM notifications_inbox') ||
			statement.text.startsWith('SELECT id FROM notifications_deliveries');
		if (target && blinded < 2) {
			blinded += 1;
			return true;
		}
		return false;
	};
	const session = (transaction: DatabaseTransaction): DatabaseTransaction => ({
		adapterId: transaction.adapterId,
		dialectId: transaction.dialectId,
		capabilities: transaction.capabilities,
		schema: transaction.schema,
		acquireMigrationLock: (namespace) =>
			transaction.acquireMigrationLock(namespace),
		execute: (statement, options) => transaction.execute(statement, options),
		executeScript: (script, options) =>
			transaction.executeScript(script, options),
		query<Row extends DatabaseRow = DatabaseRow>(
			statement: DatabaseStatement,
			options?: DatabaseOperationOptions,
		): Promise<DatabaseQueryResult<Row>> {
			return blind(statement)
				? Promise.resolve({ rows: [], rowCount: 0 })
				: transaction.query<Row>(statement, options);
		},
	});
	const runtime: DatabaseHandle = {
		adapterId: handle.adapterId,
		dialectId: handle.dialectId,
		capabilities: handle.capabilities,
		schema: handle.schema,
		query<Row extends DatabaseRow = DatabaseRow>(
			statement: DatabaseStatement,
			options?: DatabaseOperationOptions,
		): Promise<DatabaseQueryResult<Row>> {
			return handle.query<Row>(statement, options);
		},
		execute: (statement, options) => handle.execute(statement, options),
		executeScript: (script, options) => handle.executeScript(script, options),
		transaction: (operation, options) =>
			handle.transaction(
				(transaction) => operation(session(transaction)),
				options,
			),
	};
	return {
		publisher: new NotificationPublishService(
			new DatabaseNotificationsRepository({
				runtime,
				background: shared.background,
			}),
		),
		blinded: () => blinded,
	};
}

async function activeSubscription(name: string, events: readonly string[]) {
	const { webhooks } = harness();
	return webhooks.create(TENANT, 'account-owner', {
		name,
		url: 'https://hooks.example/receiver',
		events,
	});
}

describe('notifications.publish.v1', () => {
	it('NOTIFICATIONS-PUBLISH creates one inbox item per recipient and one pending delivery per matching subscription', async () => {
		const { publisher, inbox, deliveries } = harness();
		const subscribed = await activeSubscription('Ops receiver', [
			'agent-run-failed',
		]);
		const ignored = await activeSubscription('Billing receiver', [
			'workflow-run-completed',
		]);

		const result = await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-4711',
			title: 'Nightly reconciliation failed',
			body: 'The agent stopped after three tool errors.',
			recipients: ['account-ada'],
		});

		expect(result.inboxItemIds).toHaveLength(1);
		expect(result.deliveryIds).toHaveLength(1);
		const items = await inbox.list(TENANT, 'account-ada');
		expect(
			items.map((item) => [item.status, item.kind, item.sourceRef]),
		).toEqual([['unread', 'agent-run-failed', 'run-4711']]);
		const queued = await deliveries.list(TENANT, { status: 'pending' });
		expect(queued).toHaveLength(1);
		expect(queued[0]?.subscriptionId).toBe(subscribed.subscription.id);
		expect(queued[0]?.attemptNumber).toBe(1);
		expect(queued[0]?.sequence).toBe(1);
		expect(
			(
				await deliveries.list(TENANT, {
					subscriptionId: ignored.subscription.id,
				})
			).length,
		).toBe(0);
	});

	it('NOTIFICATIONS-PUBLISH carries each approval kind to the inbox and to a subscription that lists it', async () => {
		const { publisher, inbox, deliveries } = harness();
		const subscribed = await activeSubscription('Approvals receiver', [
			'approval-requested',
			'approval-decided',
		]);
		const ignored = await activeSubscription('Billing receiver', [
			'workflow-run-completed',
		]);

		for (const kind of ['approval-requested', 'approval-decided'] as const) {
			const result = await publisher.publish({
				tenantId: TENANT,
				kind,
				sourceModule: 'approvals.core',
				sourceRef: `approval-${kind}`,
				title: 'Purchase order 4711',
				recipients: ['account-ada'],
			});
			expect([kind, result.inboxItemIds.length]).toEqual([kind, 1]);
			expect([kind, result.deliveryIds.length]).toEqual([kind, 1]);
		}

		const items = await inbox.list(TENANT, 'account-ada');
		expect(
			items.map((item) => [item.kind, item.status, item.sourceRef]).sort(),
		).toEqual([
			['approval-decided', 'unread', 'approval-approval-decided'],
			['approval-requested', 'unread', 'approval-approval-requested'],
		]);
		const queued = await deliveries.list(TENANT, { status: 'pending' });
		expect(queued.map((attempt) => attempt.kind).sort()).toEqual([
			'approval-decided',
			'approval-requested',
		]);
		expect(
			queued.every(
				(attempt) => attempt.subscriptionId === subscribed.subscription.id,
			),
		).toBe(true);
		expect(
			(
				await deliveries.list(TENANT, {
					subscriptionId: ignored.subscription.id,
				})
			).length,
		).toBe(0);
	});

	it('NOTIFICATIONS-PUBLISH carries the meter threshold kind to the inbox and to a subscription that lists it', async () => {
		const { publisher, inbox, deliveries } = harness();
		const subscribed = await activeSubscription('Usage receiver', [
			'meter-threshold',
		]);
		const ignored = await activeSubscription('Billing receiver', [
			'workflow-run-completed',
		]);

		const result = await publisher.publish({
			tenantId: TENANT,
			kind: 'meter-threshold',
			sourceModule: 'metering.core',
			sourceRef: 'agents.core.run-tokens:2026-09:warning',
			title: 'Agent tokens reached 80% of the monthly limit',
			body: '80000 of 100000 tokens used this month.',
			recipients: ['account-ada'],
		});

		expect(result.inboxItemIds).toHaveLength(1);
		expect(result.deliveryIds).toHaveLength(1);
		const items = await inbox.list(TENANT, 'account-ada');
		expect(
			items.map((item) => [item.kind, item.status, item.sourceRef]),
		).toEqual([
			['meter-threshold', 'unread', 'agents.core.run-tokens:2026-09:warning'],
		]);
		const queued = await deliveries.list(TENANT, { status: 'pending' });
		expect(queued.map((attempt) => attempt.subscriptionId)).toEqual([
			subscribed.subscription.id,
		]);
		expect(
			(
				await deliveries.list(TENANT, {
					subscriptionId: ignored.subscription.id,
				})
			).length,
		).toBe(0);
	});

	it('NOTIFICATIONS-INBOX-PREFERENCE skips an approval kind the member disabled', async () => {
		const { publisher, inbox, deliveries } = harness();
		await activeSubscription('Approvals receiver', ['approval-requested']);
		await inbox.savePreference(
			TENANT,
			'account-ada',
			'approval-requested',
			false,
		);

		const result = await publisher.publish({
			tenantId: TENANT,
			kind: 'approval-requested',
			sourceModule: 'approvals.core',
			sourceRef: 'approval-7001',
			title: 'Purchase order 7001',
			recipients: ['account-ada', 'account-bo'],
		});

		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(0);
		expect(await inbox.list(TENANT, 'account-bo')).toHaveLength(1);
		expect(result.inboxItemIds).toHaveLength(1);
		expect(await deliveries.list(TENANT, { status: 'pending' })).toHaveLength(
			1,
		);
	});

	it('NOTIFICATIONS-PUBLISH-REPEAT writes nothing and returns the original identifiers', async () => {
		const { publisher, inbox, deliveries } = harness();
		await activeSubscription('Ops receiver', ['agent-run-failed']);
		const input = {
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-4711',
			title: 'Nightly reconciliation failed',
			recipients: ['account-ada', 'account-bo'],
		} as const;

		const first = await publisher.publish(input);
		const second = await publisher.publish({
			...input,
			title: 'Changed title',
		});

		expect(second.inboxItemIds).toEqual(first.inboxItemIds);
		expect(second.deliveryIds).toEqual(first.deliveryIds);
		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(1);
		expect((await inbox.list(TENANT, 'account-ada'))[0]?.title).toBe(
			'Nightly reconciliation failed',
		);
		expect(await deliveries.list(TENANT, {})).toHaveLength(1);
	});

	it('NOTIFICATIONS-PUBLISH-REPEAT answers with the original identifiers when a concurrent publication won the unique index', async () => {
		const { publisher, inbox, deliveries } = harness();
		await activeSubscription('Ops receiver', ['agent-run-failed']);
		const input = {
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-race',
			title: 'Nightly reconciliation failed',
			recipients: ['account-ada'],
		} as const;
		const first = await publisher.publish(input);
		expect(first.inboxItemIds).toHaveLength(1);
		expect(first.deliveryIds).toHaveLength(1);

		const loser = blindFirstIdempotencyRead(shared.runtime);
		const second = await loser.publisher.publish(input);

		/* Both idempotency reads have to have been blinded, or the case proves
		   nothing about the conflict path. */
		expect(loser.blinded()).toBe(2);
		expect(second.inboxItemIds).toEqual(first.inboxItemIds);
		expect(second.deliveryIds).toEqual(first.deliveryIds);
		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(1);
		expect(await deliveries.list(TENANT, {})).toHaveLength(1);
	});

	it('NOTIFICATIONS-INBOX-PREFERENCE skips a disabled kind for that member and leaves deliveries untouched', async () => {
		const { publisher, inbox, deliveries } = harness();
		await activeSubscription('Ops receiver', ['agent-run-completed']);
		await inbox.savePreference(
			TENANT,
			'account-ada',
			'agent-run-completed',
			false,
		);

		const result = await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-completed',
			sourceModule: 'agents.core',
			sourceRef: 'run-9000',
			title: 'Nightly reconciliation finished',
			recipients: ['account-ada', 'account-bo'],
		});

		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(0);
		expect(await inbox.list(TENANT, 'account-bo')).toHaveLength(1);
		expect(result.inboxItemIds).toHaveLength(1);
		expect(result.deliveryIds).toHaveLength(1);
		expect(await deliveries.list(TENANT, { status: 'pending' })).toHaveLength(
			1,
		);
	});

	it('re-enabling a kind lets the next event through for that member', async () => {
		const { publisher, inbox } = harness();
		await inbox.savePreference(
			TENANT,
			'account-ada',
			'agent-run-failed',
			false,
		);
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-1',
			title: 'First',
			recipients: ['account-ada'],
		});
		await inbox.savePreference(TENANT, 'account-ada', 'agent-run-failed', true);
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-2',
			title: 'Second',
			recipients: ['account-ada'],
		});

		expect(
			(await inbox.list(TENANT, 'account-ada')).map((i) => i.sourceRef),
		).toEqual(['run-2']);
	});

	it('refuses input beyond the declared bounds before anything is written', async () => {
		const { publisher, inbox } = harness();
		await expect(
			publisher.publish({
				tenantId: TENANT,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				sourceRef: 'run-bounds',
				title: 'x'.repeat(201),
				recipients: ['account-ada'],
			}),
		).rejects.toBeInstanceOf(NotificationsServiceError);
		await expect(
			publisher.publish({
				tenantId: TENANT,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				sourceRef: 'run-bounds',
				title: 'Fine',
				recipients: Array.from(
					{ length: 65 },
					(_, index) => `account-${index}`,
				),
			}),
		).rejects.toBeInstanceOf(NotificationsServiceError);
		expect(await inbox.list(TENANT, 'account-ada')).toHaveLength(0);
	});

	it('publishes under a capability id the registry accepts', () => {
		expect(NOTIFICATIONS_PUBLISH_CAPABILITY).toBe('notifications.publish.v1');
		expect(NOTIFICATIONS_PUBLISH_CAPABILITY).toMatch(
			/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/,
		);
	});
});
