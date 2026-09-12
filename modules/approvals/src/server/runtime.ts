import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { JobRunner } from '@flowdular/server';
import type { ApprovalMember } from '../domain/types.ts';
import {
	createApprovalCallbackRegistry,
	type ApprovalCallbackRegistry,
} from '../services/callbacks.ts';
import {
	DatabaseApprovalsRepository,
	migrateApprovalsDatabase,
} from '../services/database-repository.ts';
import { createApprovalsExpiryRunner } from '../services/expiry-runner.ts';
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
	let jobs: JobRunner | undefined;
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

	/* The platform runner owns the loop: the interval and its unref, the guard
	   against overlapping passes, the bound on claims, the isolation of one
	   request from the next, and the drain. This module keeps its routing read
	   and its transition. The interval is the platform setting as it reads when
	   the loop starts, so the runner is built there rather than while the
	   platform composes, before the setting is declared. */
	const runner = (): JobRunner =>
		(jobs ??= createApprovalsExpiryRunner({
			repository: repositoryInstance,
			service: resolved,
			intervalMs: options.expiryIntervalMs(),
			...(options.now ? { now: options.now } : {}),
		}));

	return {
		service: resolved,
		repository: repositoryInstance,
		start() {
			if (disposed) return;
			runner().start();
		},
		stop: () => jobs?.stop(),
		async quiesce() {
			await jobs?.quiesce();
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await jobs?.dispose();
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
