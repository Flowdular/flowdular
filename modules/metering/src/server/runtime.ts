import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type {
	MeterCheckInput,
	MeterCheckResult,
	MeterDeclaration,
	MeterRecordInput,
	MeterRecordResult,
	MeterRegistry,
} from '../domain/meters.ts';
import {
	DatabaseMeteringRepository,
	migrateMeteringDatabase,
} from '../services/database-repository.ts';
import { MeterDeclarationRegistry } from '../services/meter-registry.ts';
import { MeteringService } from '../services/metering-service.ts';
import type { NotificationPublisherResolver } from '../services/notifications.ts';
import { MeteringServiceError } from '../services/service-error.ts';
import type { MeteringRepository } from '../services/repository.ts';

export interface MeteringRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	/** Live platform setting, read again for every fact. */
	readonly warningPercent: () => number;
	/** Account ids of the workspace owners, resolved through auth.core. */
	readonly owners?: (tenantId: string) => Promise<readonly string[]>;
	readonly notifications?: NotificationPublisherResolver;
	readonly now?: () => number;
	/** Supplied by tests that own the leases themselves. */
	readonly repository?: MeteringRepository;
	/**
	 * `verify` reads the ledger and applies no DDL, for a caller that is not
	 * applying anything (a read command, a dry run). It refuses a schema the
	 * deployment has not migrated yet instead of creating one.
	 */
	readonly migrations?: 'apply' | 'verify';
}

export interface MeteringRuntime {
	/** The declaration half, available before any database is open. */
	readonly registry: MeterDeclarationRegistry;
	/** The object registered as `metering.meters.v1`. */
	readonly meters: MeterRegistry;
	service(): Promise<MeteringService>;
	/** Seals the registry: composition is over and nothing may declare now. */
	start(): void;
	dispose(): Promise<void>;
}

export function createMeteringRuntime(
	options: MeteringRuntimeOptions,
): MeteringRuntime {
	const registry = new MeterDeclarationRegistry();
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<MeteringService> | undefined;

	const build = (repository: MeteringRepository): MeteringService =>
		new MeteringService({
			repository,
			registry,
			warningPercent: options.warningPercent,
			...(options.owners ? { owners: options.owners } : {}),
			...(options.notifications
				? { notifications: options.notifications }
				: {}),
			...(options.now ? { now: options.now } : {}),
		});

	/* Schema work runs on the migrator role and that lease is released before
	   the runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<MeteringService> => {
		if (options.repository) return build(options.repository);
		const migrationLease = await options.databases.acquire({
			namespace: 'metering.core',
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
		const verifyOnly = options.migrations === 'verify';
		try {
			const state = await migrateMeteringDatabase(migrationLease.database, {
				dryRun: verifyOnly,
			});
			if (verifyOnly && state.some((entry) => entry.action === 'applied')) {
				throw new MeteringServiceError(
					'SCHEMA_NOT_MIGRATED',
					'metering.core has no schema in this deployment yet. Start the platform, or run the command with --apply, to create it.',
					503,
				);
			}
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'metering.core',
			purpose: options.purpose ?? 'runtime',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				],
			},
		});
		const lease = await runtimeLeasePromise;
		return build(new DatabaseMeteringRepository(lease.database));
	};

	const service = (): Promise<MeteringService> => {
		if (disposed) {
			return Promise.reject(new Error('Metering runtime is disposed.'));
		}
		servicePromise ??= initialize();
		return servicePromise;
	};

	/* The capability object is handed out at composition, before any database is
	   open. `declare` is answered in process; a fact opens the database on its
	   first call and every later one reuses the same lease. */
	const meters: MeterRegistry = {
		declare: (moduleId: string, declarations: readonly MeterDeclaration[]) =>
			registry.declare(moduleId, declarations),
		record: async (input: MeterRecordInput): Promise<MeterRecordResult> =>
			(await service()).record(input),
		check: async (input: MeterCheckInput): Promise<MeterCheckResult> =>
			(await service()).check(input),
	};

	return {
		registry,
		meters,
		service,
		start: () => registry.seal(),
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!runtimeLeasePromise) {
				await servicePromise?.catch(() => undefined);
			}
			if (!runtimeLeasePromise) return;
			const lease = await runtimeLeasePromise;
			await lease.release();
			runtimeLeasePromise = undefined;
			servicePromise = undefined;
		},
	};
}
