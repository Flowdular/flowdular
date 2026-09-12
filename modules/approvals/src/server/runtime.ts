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
import type { ApprovalMember } from '../domain/types.ts';
import {
	createApprovalCallbackRegistry,
	type ApprovalCallbackRegistry,
} from '../services/callbacks.ts';
import {
	DatabaseApprovalsRepository,
	migrateApprovalsDatabase,
} from '../services/database-repository.ts';
import type { NotificationPublisherResolver } from '../services/notifications.ts';
import type { ApprovalsRepository } from '../services/repository.ts';
import { ApprovalsService } from '../services/approvals-service.ts';

export interface ApprovalsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	/** Members and their current role and scopes, resolved through auth.core. */
	readonly members: (tenantId: string) => Promise<readonly ApprovalMember[]>;
	/** One member's current role and scopes, resolved through auth.core. */
	readonly member: (
		tenantId: string,
		accountId: string,
	) => Promise<ApprovalMember | null>;
	/** Live tenant setting, read again for every request that needs it. */
	readonly defaultExpiryDays: (tenantId: string) => number;
	/** Live platform setting, read when the loop starts. */
	readonly expiryIntervalMs: () => number;
	readonly notifications?: NotificationPublisherResolver;
	readonly callbacks?: ApprovalCallbackRegistry;
	readonly repository?: ApprovalsRepository;
	readonly now?: () => number;
}

export interface ApprovalsRuntime {
	service(): Promise<ApprovalsService>;
	/** The open repository, for the operations behind the declared data class. */
	repository(): Promise<ApprovalsRepository>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createApprovalsRuntime(
	options: ApprovalsRuntimeOptions,
): ApprovalsRuntime {
	const callbacks = options.callbacks ?? createApprovalCallbackRegistry();
	let repositoryPromise: Promise<ApprovalsRepository> | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];
	let service: ApprovalsService | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let tickInFlight: Promise<void> | undefined;
	let disposed = false;

	const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
		options.databases.acquire({
			namespace: 'approvals.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});

	const openRepository = async (): Promise<ApprovalsRepository> => {
		if (options.repository) return options.repository;
		/* Schema work runs on the migrator role and that lease is released before
		   the runtime one is taken, so request handling never holds a schema owner. */
		const migration = await options.databases.acquire({
			namespace: 'approvals.core',
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
			await migrateApprovalsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(options.purpose ?? 'runtime');
		/* The expiry poll reads across tenants; every write that follows uses the
		   tenant carried by the routing row it returned. */
		const backgroundLease = await acquire('background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseApprovalsRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repositoryInstance = (): Promise<ApprovalsRepository> =>
		(repositoryPromise ??= openRepository());

	const resolved = async (): Promise<ApprovalsService> =>
		(service ??= new ApprovalsService({
			repository: await repositoryInstance(),
			members: options.members,
			member: options.member,
			defaultExpiryDays: options.defaultExpiryDays,
			callbacks,
			...(options.notifications
				? { notifications: options.notifications }
				: {}),
			...(options.now ? { now: options.now } : {}),
		}));

	const tick = () => {
		if (disposed || tickInFlight) return;
		const pending = resolved()
			.then((instance) => instance.expireDue())
			.then(() => undefined)
			.catch((error: unknown) => {
				/* A failed pass must never stop the interval: the next tick reads the
				   same due requests again. */
				serverLogger().error('approval expiry tick failed', {
					module: 'approvals.core',
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
		service: resolved,
		repository: repositoryInstance,
		start() {
			if (disposed || poll) return;
			tick();
			poll = setInterval(tick, options.expiryIntervalMs());
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
			service = undefined;
		},
	};
}
