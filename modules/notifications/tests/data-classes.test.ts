import { createDataClassRegistry } from '@flowdular/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryAttempt } from '../src/domain/types.ts';
import {
	DELIVERY_RETENTION_DAYS,
	INBOX_RETENTION_DAYS,
	notificationsDataClasses,
} from '../src/services/data-classes.ts';
import type { NotificationsRepository } from '../src/services/repository.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness } from './support/harness.ts';

const TENANT = 'tenant-classes';
const OTHER = 'tenant-other';
const DAY_MS = 86_400_000;
const SEPTEMBER = Date.UTC(2026, 8, 11, 9, 30, 0);

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

function declared(key: 'inbox' | 'deliveries', pageSize?: number) {
	const registry = createDataClassRegistry();
	registry.declare(
		'notifications.core',
		pageSize === undefined
			? notificationsDataClasses(async () => shared.repository)
			: notificationsDataClasses(async () => shared.repository, pageSize),
	);
	const entry = registry
		.list()
		.find((module) => module.moduleId === 'notifications.core');
	const declaration = entry?.classes.find((item) => item.key === key);
	if (!declaration) {
		throw new Error(`notifications.core declared no ${key} class.`);
	}
	return declaration;
}

/** One inbox item per consecutive day, the oldest three days back. */
async function seedInbox(
	tenantId: string,
	days: number,
	recipient = 'account-ada',
): Promise<void> {
	for (let offset = 0; offset < days; offset += 1) {
		const at = SEPTEMBER - (days - 1 - offset) * DAY_MS;
		const { publisher } = createHarness({
			repository: shared.repository,
			now: () => at,
		});
		await publisher.publish({
			tenantId,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: `run-${tenantId}-${offset}`,
			title: `Run ${offset}`,
			recipients: [recipient],
		});
	}
}

function attempt(
	tenantId: string,
	id: string,
	at: number,
	status: DeliveryAttempt['status'],
): DeliveryAttempt {
	return {
		id,
		tenantId,
		subscriptionId: 'subscription-1',
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef: id,
		title: 'Run failed',
		sequence: 1,
		attemptNumber: 1,
		status,
		scheduledFor: at,
		completedAt: status === 'pending' ? null : at,
		responseStatus: status === 'succeeded' ? 200 : null,
		errorClass: null,
		payloadDigest: 'sha256:0',
		payloadBytes: 12,
		occurredAt: at,
		createdAt: at,
	};
}

async function seedDeliveries(
	repository: NotificationsRepository,
): Promise<void> {
	for (let offset = 0; offset < 4; offset += 1) {
		const at = SEPTEMBER - (3 - offset) * DAY_MS;
		await repository.appendDelivery(
			attempt(TENANT, `delivery-${offset}`, at, 'succeeded'),
		);
	}
	/* Still queued on the oldest day of all: the loop owns it, so no retention
	   pass may take it. */
	await repository.appendDelivery(
		attempt(TENANT, 'delivery-open', SEPTEMBER - 9 * DAY_MS, 'pending'),
	);
	await repository.appendDelivery(
		attempt(OTHER, 'delivery-other', SEPTEMBER - 3 * DAY_MS, 'succeeded'),
	);
}

async function inboxIds(tenantId: string): Promise<readonly string[]> {
	const rows: Record<string, unknown>[] = [];
	await declared('inbox').export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return rows.map((row) => String(row['sourceRef']));
}

async function deliveryIds(tenantId: string): Promise<readonly string[]> {
	const rows: Record<string, unknown>[] = [];
	await declared('deliveries').export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return rows.map((row) => String(row['id']));
}

describe('notifications.core data classes', () => {
	it('declares the inbox and the delivery ledger with their retention', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'notifications.core',
			notificationsDataClasses(async () => shared.repository),
		);

		expect(
			registry
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
					]),
				),
		).toEqual([
			['notifications.core.inbox', INBOX_RETENTION_DAYS, true],
			['notifications.core.deliveries', DELIVERY_RETENTION_DAYS, true],
		]);
	});

	it('removes the inbox items older than the cutoff and keeps the cutoff day', async () => {
		await seedInbox(TENANT, 4);

		const removed = await declared('inbox').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - DAY_MS),
			limit: 100,
		});

		/* The two oldest go; the item written exactly on the cutoff stays, which
		   is what "strictly older" means. */
		expect(removed).toEqual({ removed: 2 });
		expect(await inboxIds(TENANT)).toEqual([
			`run-${TENANT}-2`,
			`run-${TENANT}-3`,
		]);
	});

	it('removes no more inbox items than the limit it was given', async () => {
		await seedInbox(TENANT, 4);

		const removed = await declared('inbox').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 1,
		});

		expect(removed).toEqual({ removed: 1 });
		expect(await inboxIds(TENANT)).toHaveLength(3);
	});

	it('sweeps the inbox of one workspace without touching another', async () => {
		await seedInbox(TENANT, 4);
		await seedInbox(OTHER, 2, 'account-bo');

		await declared('inbox').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER + DAY_MS),
			limit: 100,
		});

		expect(await inboxIds(TENANT)).toEqual([]);
		expect(await inboxIds(OTHER)).toEqual([`run-${OTHER}-0`, `run-${OTHER}-1`]);
	});

	it('sweeps completed deliveries only, in the given workspace only', async () => {
		await seedDeliveries(shared.repository);

		const removed = await declared('deliveries').sweep!({
			tenantId: TENANT,
			cutoff: new Date(SEPTEMBER - DAY_MS),
			limit: 100,
		});

		expect(removed).toEqual({ removed: 2 });
		/* The queued attempt predates every swept one and is still there: the
		   delivery loop, not the retention pass, decides when it leaves. */
		expect(await deliveryIds(TENANT)).toEqual([
			'delivery-open',
			'delivery-2',
			'delivery-3',
		]);
		expect(await deliveryIds(OTHER)).toEqual(['delivery-other']);
	});

	it('exports the inbox of one workspace with its oldest and newest time', async () => {
		await seedInbox(TENANT, 4);
		await seedInbox(OTHER, 1, 'account-bo');
		const rows: Record<string, unknown>[] = [];

		const summary = await declared('inbox').export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(4);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 3 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.map((row) => row['tenantId'])).toEqual([
			TENANT,
			TENANT,
			TENANT,
			TENANT,
		]);
	});

	it('walks the export in pages rather than one query', async () => {
		await seedInbox(TENANT, 4);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared('inbox', 2).export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(4);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(4);
	});

	it('exports the delivery ledger of one workspace by publication time', async () => {
		await seedDeliveries(shared.repository);
		const rows: Record<string, unknown>[] = [];

		const summary = await declared('deliveries').export!({
			tenantId: TENANT,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(5);
		expect(summary.from?.toISOString()).toBe(
			new Date(SEPTEMBER - 9 * DAY_MS).toISOString(),
		);
		expect(summary.to?.toISOString()).toBe(new Date(SEPTEMBER).toISOString());
		expect(rows.every((row) => row['tenantId'] === TENANT)).toBe(true);
	});

	it('exports nothing and reports no range for a workspace that holds none', async () => {
		await seedInbox(TENANT, 2);
		await seedDeliveries(shared.repository);

		for (const key of ['inbox', 'deliveries'] as const) {
			expect(
				await declared(key).export!({
					tenantId: 'tenant-empty',
					sink: { write: async () => undefined },
				}),
			).toEqual({ rows: 0, from: null, to: null });
		}
	});
});
