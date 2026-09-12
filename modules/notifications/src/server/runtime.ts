import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { serverLogger } from '@flowdular/server';
import {
	createWebhookEgressPolicy,
	webhookHostAllowlist,
	type HostAddressResolver,
	type WebhookEgressPolicy,
} from '../services/egress.ts';
import {
	DeliveryService,
	type DeliveryTransport,
	type TenantDeliverySettings,
	type TenantMemberScopes,
} from '../services/delivery-service.ts';
import {
	DatabaseNotificationsRepository,
	migrateNotificationsDatabase,
} from '../services/database-repository.ts';
import { NotificationPublishService } from '../services/publish-service.ts';
import type { NotificationsRepository } from '../services/repository.ts';
import { NotificationsService } from '../services/notifications-service.ts';
import {
	secretVaultFromEnvironment,
	type SecretVault,
} from '../services/secret-vault.ts';
import { WebhookSubscriptionService } from '../services/webhook-service.ts';

export interface NotificationsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
	readonly secretVault?: SecretVault;
	/** Live tenant settings for retry, backoff and retention. */
	readonly deliverySettings: (tenantId: string) => TenantDeliverySettings;
	/** Live platform allowlist, read again for every check. */
	readonly egressAllowlist: () => string;
	readonly pollIntervalMs: () => number;
	/** Members and their current scopes, resolved through auth.core. */
	readonly members: (
		tenantId: string,
	) => Promise<readonly TenantMemberScopes[]>;
	readonly repository?: NotificationsRepository;
	/** Test seam for the address check; never reachable from configuration. */
	readonly hostResolver?: HostAddressResolver;
	/** Test seam for the outbound request itself. */
	readonly transport?: DeliveryTransport;
	readonly now?: () => number;
}

export interface NotificationsRuntime {
	/**
	 * The persistence port itself, for the workspace-wide operations the data
	 * class registry drives. The member-facing service takes a recipient on
	 * every call, so a sweep and an export of the whole workspace cannot go
	 * through it.
	 */
	repository(): Promise<NotificationsRepository>;
	service(): Promise<NotificationsService>;
	webhooks(): Promise<WebhookSubscriptionService>;
	deliveries(): Promise<DeliveryService>;
	publisher(): Promise<NotificationPublishService>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createNotificationsRuntime(
	options: NotificationsRuntimeOptions,
): NotificationsRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const now = options.now ?? Date.now;
	let repositoryPromise: Promise<NotificationsRepository> | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];

	const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
		options.databases.acquire({
			namespace: 'notifications.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});

	const openRepository = async (): Promise<NotificationsRepository> => {
		if (options.repository) return options.repository;
		/* Schema work runs on the migrator role and that lease is released before
		   the runtime one is taken, so request handling never holds a schema owner. */
		const migration = await options.databases.acquire({
			namespace: 'notifications.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migrateNotificationsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(options.purpose ?? 'runtime');
		/* The delivery poll reads across tenants; every write that follows uses
		   the tenant carried by the routing row it returned. */
		const backgroundLease = await acquire('background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseNotificationsRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repositoryInstance = (): Promise<NotificationsRepository> =>
		(repositoryPromise ??= openRepository());

	const vault =
		options.secretVault ??
		secretVaultFromEnvironment(environment, workspaceRoot);
	/* The allowlist is read on every check, so a settings change takes effect
	   without a restart. */
	const policy = (): WebhookEgressPolicy =>
		createWebhookEgressPolicy({
			allowlist: webhookHostAllowlist(options.egressAllowlist()),
			resolve: options.hostResolver,
		});

	let inbox: NotificationsService | undefined;
	let webhooks: WebhookSubscriptionService | undefined;
	let deliveries: DeliveryService | undefined;
	let publisher: NotificationPublishService | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let tickInFlight: Promise<void> | undefined;
	let disposed = false;

	const service = async () =>
		(inbox ??= new NotificationsService(await repositoryInstance()));
	const webhookService = async () =>
		(webhooks ??= new WebhookSubscriptionService(
			await repositoryInstance(),
			vault,
			policy,
			now,
		));
	const deliveryService = async () =>
		(deliveries ??= new DeliveryService({
			repository: await repositoryInstance(),
			vault,
			policy,
			settings: options.deliverySettings,
			members: options.members,
			now,
			...(options.transport ? { transport: options.transport } : {}),
		}));
	const publishService = async () =>
		(publisher ??= new NotificationPublishService(
			await repositoryInstance(),
			now,
		));

	const tick = () => {
		if (disposed || tickInFlight) return;
		const pending = deliveryService()
			.then((delivery) => delivery.tick())
			.then(() => undefined)
			.catch((error: unknown) => {
				/* A failed pass must never stop the interval: the next tick retries
				   the same due rows. */
				serverLogger().error('delivery tick failed', {
					module: 'notifications.core',
					err: error,
				});
			})
			.finally(() => {
				if (tickInFlight === pending) tickInFlight = undefined;
			});
		tickInFlight = pending;
	};

	const stop = () => {
		if (poll) clearInterval(poll);
		poll = undefined;
	};

	const quiesce = async () => {
		stop();
		await tickInFlight;
	};

	return {
		repository: repositoryInstance,
		service,
		webhooks: webhookService,
		deliveries: deliveryService,
		publisher: publishService,
		start() {
			if (disposed || poll) return;
			tick();
			poll = setInterval(tick, options.pollIntervalMs());
			poll.unref?.();
		},
		stop,
		quiesce,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await quiesce();
			/* An open still in flight would assign its leases after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await repositoryPromise?.catch(() => undefined);
			for (const lease of leases) await lease.release();
			leases = [];
			repositoryPromise = undefined;
			inbox = undefined;
			webhooks = undefined;
			deliveries = undefined;
			publisher = undefined;
		},
	};
}
