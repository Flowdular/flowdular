import {
	DeliveryService,
	type DeliveryServiceOptions,
	type TenantDeliverySettings,
	type TenantMemberScopes,
	type WebhookConnectSeam,
} from '../../src/services/delivery-service.ts';
import {
	createWebhookEgressPolicy,
	webhookHostAllowlist,
	type HostAddressResolver,
	type WebhookEgressPolicy,
} from '../../src/services/egress.ts';
import { NotificationsService } from '../../src/services/notifications-service.ts';
import { NotificationPublishService } from '../../src/services/publish-service.ts';
import type {
	NotificationsRepository,
	StoredWebhookSubscription,
} from '../../src/services/repository.ts';
import {
	AesGcmSecretVault,
	generateWebhookSecret,
	secretContext,
	secretFingerprint,
	type SecretVault,
} from '../../src/services/secret-vault.ts';
import { WebhookSubscriptionService } from '../../src/services/webhook-service.ts';
import { TEST_CERTIFICATE } from './tls.ts';

export const TEST_SETTINGS: TenantDeliverySettings = {
	retryMaxAttempts: 3,
	retryMaxBackoffMinutes: 360,
	retentionDays: 30,
};

/** The host every delivery test points at; the fixture certificate covers it. */
export const TEST_HOST = 'hooks.example.test';
/** What the injected resolver answers for it: a public address, as a real one. */
export const TEST_PUBLIC_ADDRESS = '93.184.216.34';

/**
 * The only way the private-range block is relaxed: an explicit resolver handed
 * to the policy. There is no environment flag, so a deployment cannot reach
 * this path, and a test server on 127.0.0.1 still crosses the same code.
 */
export function publicResolver(
	addresses: Readonly<Record<string, string>> = {},
): HostAddressResolver {
	return async (hostname) => {
		const mapped = addresses[hostname.toLowerCase()];
		if (mapped) return [{ address: mapped }];
		throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
	};
}

/** The resolver every delivery test runs under: the test host answers publicly. */
export function testResolver(): HostAddressResolver {
	return publicResolver({ [TEST_HOST]: TEST_PUBLIC_ADDRESS });
}

/**
 * The connect seam a delivery test runs under. The policy verifies a public
 * address exactly as a deployment would, and the socket goes to the loopback
 * port the test endpoint listens on; `dialled` records what the delivery path
 * asked to reach, which is how a pinned address is observed.
 */
export function testConnect(dialled?: string[]): WebhookConnectSeam {
	return {
		dial: (address) => {
			dialled?.push(address);
			return '127.0.0.1';
		},
		ca: TEST_CERTIFICATE,
	};
}

export interface SeedSubscriptionOptions {
	readonly repository: NotificationsRepository;
	readonly vault: SecretVault;
	readonly tenantId: string;
	readonly url: string;
	readonly now: number;
	readonly events?: readonly string[];
	readonly status?: 'active' | 'paused';
}

/* The save path refuses a URL whose host resolves to the loopback range, so a
   subscription pointing at a test endpoint is written straight to the store,
   exactly as a deployment would hold a public one. */
export async function seedSubscription(
	options: SeedSubscriptionOptions,
): Promise<{ readonly id: string; readonly secret: string }> {
	const id = `subscription-${Math.random().toString(36).slice(2, 10)}`;
	const secret = generateWebhookSecret();
	const record: StoredWebhookSubscription = {
		id,
		tenantId: options.tenantId,
		name: `Receiver ${id}`,
		url: options.url,
		events: (options.events ?? ['agent-run-failed']) as never,
		secretFingerprint: secretFingerprint(secret),
		secretRevision: 1,
		status: options.status ?? 'active',
		description: null,
		lastDeliveryAt: null,
		createdAt: options.now,
		updatedAt: options.now,
		createdBy: 'account-owner',
		secret: options.vault.encrypt(secret, secretContext(options.tenantId, id)),
	};
	await options.repository.createSubscription(record);
	return { id, secret };
}

export interface HarnessOptions {
	readonly repository: NotificationsRepository;
	readonly now?: () => number;
	readonly allowlist?: string;
	readonly resolve?: HostAddressResolver;
	readonly settings?: TenantDeliverySettings;
	readonly members?: readonly TenantMemberScopes[];
	readonly transport?: DeliveryServiceOptions['transport'];
	readonly connect?: WebhookConnectSeam;
}

export function createHarness(options: HarnessOptions) {
	const vault = new AesGcmSecretVault(Buffer.alloc(32, 0x4e));
	const now = options.now ?? Date.now;
	const policy = (): WebhookEgressPolicy =>
		createWebhookEgressPolicy({
			allowlist: webhookHostAllowlist(options.allowlist ?? ''),
			resolve: options.resolve,
		});
	return {
		vault,
		policy,
		inbox: new NotificationsService(options.repository),
		publisher: new NotificationPublishService(options.repository, now),
		webhooks: new WebhookSubscriptionService(
			options.repository,
			vault,
			policy,
			now,
		),
		deliveries: new DeliveryService({
			repository: options.repository,
			vault,
			policy,
			settings: () => options.settings ?? TEST_SETTINGS,
			members: async () => options.members ?? [],
			now,
			...(options.transport ? { transport: options.transport } : {}),
			...(options.connect ? { connect: options.connect } : {}),
		}),
	};
}
