import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNotificationsRuntime } from '../src/server/runtime.ts';
import type { DeliveryTransport } from '../src/services/delivery-service.ts';
import {
	generateWebhookSecret,
	secretContext,
	secretFingerprint,
	AesGcmSecretVault,
} from '../src/services/secret-vault.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { publicResolver, TEST_SETTINGS } from './support/harness.ts';

const TENANT = 'tenant-runtime';

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

function runtimeWith(transport: DeliveryTransport, pollIntervalMs = 20) {
	const vault = new AesGcmSecretVault(Buffer.alloc(32, 0x4e));
	return {
		vault,
		runtime: createNotificationsRuntime({
			databases: shared.databases,
			repository: shared.repository,
			secretVault: vault,
			deliverySettings: () => TEST_SETTINGS,
			egressAllowlist: () => '',
			pollIntervalMs: () => pollIntervalMs,
			members: async () => [],
			hostResolver: publicResolver({ 'hooks.example': '93.184.216.34' }),
			transport,
		}),
	};
}

async function queueOne(vault: AesGcmSecretVault): Promise<void> {
	const id = 'subscription-runtime';
	const secret = generateWebhookSecret();
	await shared.repository.createSubscription({
		id,
		tenantId: TENANT,
		name: 'Runtime receiver',
		url: 'https://hooks.example/receiver',
		events: ['agent-run-failed'],
		secretFingerprint: secretFingerprint(secret),
		secretRevision: 1,
		status: 'active',
		description: null,
		lastDeliveryAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		createdBy: 'account-owner',
		secret: vault.encrypt(secret, secretContext(TENANT, id)),
	});
	await (
		await runtimeWith({
			send: async () => ({
				status: 'succeeded' as const,
				responseStatus: 200,
				errorClass: null,
			}),
		}).runtime.publisher()
	).publish({
		tenantId: TENANT,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef: 'run-runtime',
		title: 'Queued for the loop',
		recipients: [],
	});
}

async function settle(check: () => Promise<boolean>): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

describe('notifications runtime lifecycle', () => {
	it('drains the queue once start schedules the loop', async () => {
		let sent = 0;
		const { vault, runtime } = runtimeWith({
			send: async () => {
				sent += 1;
				return { status: 'succeeded', responseStatus: 200, errorClass: null };
			},
		});
		try {
			await queueOne(vault);
			runtime.start();
			expect(await settle(async () => sent > 0)).toBe(true);
			expect(
				(await (await runtime.deliveries()).list(TENANT, {}))[0]?.status,
			).toBe('succeeded');
		} finally {
			await runtime.dispose();
		}
	});

	it('stops scheduling after stop and drains the pass in flight on quiesce', async () => {
		let sent = 0;
		const { vault, runtime } = runtimeWith({
			send: async () => {
				sent += 1;
				return { status: 'succeeded', responseStatus: 200, errorClass: null };
			},
		});
		try {
			runtime.start();
			await runtime.quiesce();
			const before = sent;
			await queueOne(vault);
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(sent).toBe(before);
			expect(
				(await (await runtime.deliveries()).list(TENANT, {}))[0]?.status,
			).toBe('pending');
		} finally {
			await runtime.dispose();
		}
	});
});
