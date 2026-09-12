import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { JobRunner, MailPort } from '@flowdular/server';
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
	createNotificationDeliveryRunner,
	createNotificationRetentionRunner,
} from '../services/delivery-runner.ts';
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
	/** The platform mail port the e-mail channel sends through. */
	readonly mail: MailPort;
	/** The language one workspace's messages say they are written in. */
	readonly locale?: (tenantId: string) => string;
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
	let jobs: readonly JobRunner[] | undefined;
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
			mail: options.mail,
			now,
			...(options.locale ? { locale: options.locale } : {}),
			...(options.transport ? { transport: options.transport } : {}),
		}));
	const publishService = async () =>
		(publisher ??= new NotificationPublishService(
			await repositoryInstance(),
			now,
		));

	/* The cadence is read when the loops are built, as the setting's description
	   says: an edited interval applies the next time the platform starts. */
	const runners = (): readonly JobRunner[] => {
		if (jobs) return jobs;
		const intervalMs = options.pollIntervalMs();
		return (jobs = [
			createNotificationDeliveryRunner({
				repository: repositoryInstance,
				deliveries: deliveryService,
				intervalMs,
				now,
			}),
			createNotificationRetentionRunner({
				deliveries: deliveryService,
				intervalMs,
				now,
			}),
		]);
	};

	const stop = () => {
		for (const runner of jobs ?? []) runner.stop();
	};

	const quiesce = async () => {
		for (const runner of jobs ?? []) await runner.quiesce();
	};

	return {
		repository: repositoryInstance,
		service,
		webhooks: webhookService,
		deliveries: deliveryService,
		publisher: publishService,
		start() {
			if (disposed) return;
			for (const runner of runners()) runner.start();
		},
		stop,
		quiesce,
		async dispose() {
			if (disposed) return;
			disposed = true;
			/* Every loop stops before the first drain is awaited: a runner still
			   scheduling passes while another is being drained would keep opening
			   work against a repository this call is about to release. */
			stop();
			for (const runner of jobs ?? []) await runner.dispose();
			jobs = undefined;
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
