import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { PlatformDataClassRegistry } from '@flowdular/kernel';
import { serverLogger } from '@flowdular/server';
import {
	anchorSignerFromEnvironment,
	type AnchorSigner,
} from '../services/anchor-key.ts';
import {
	createBackupGuard,
	type BackupGuard,
} from '../services/backup-guard.ts';
import {
	DatabaseAuditRepository,
	migrateAuditDatabase,
} from '../services/database-repository.ts';
import {
	createErasureRegistry,
	type MutableAuditErasureRegistry,
} from '../services/erasure-port.ts';
import {
	AuditErasureService,
	ERASURE_POLL_INTERVAL_MS,
} from '../services/erasure-service.ts';
import {
	AuditExportService,
	EXPORT_POLL_INTERVAL_MS,
} from '../services/export-service.ts';
import {
	AuditHoldService,
	type LegalHoldCheck,
} from '../services/hold-service.ts';
import { auditOwnDataClasses } from '../services/own-classes.ts';
import { AuditSealService } from '../services/seal-service.ts';
import { readPlatformVersion } from '../services/platform-version.ts';
import type { AuditRepository } from '../services/repository.ts';
import { AuditRetentionService } from '../services/retention-service.ts';
import { AuditSweepService } from '../services/sweep-service.ts';

export interface AuditRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	/**
	 * The platform registry this module declares into and reads. A process that
	 * composes no module, such as the operator command, passes its own registry
	 * and reaches no owner port, which is why the export itself belongs to the
	 * running platform.
	 */
	readonly dataClasses: PlatformDataClassRegistry;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
	/** Live platform settings, read again on every pass. */
	readonly sweepIntervalMs: () => number;
	readonly sweepBatchSize: () => number;
	readonly platformVersion?: string;
	readonly repository?: AuditRepository;
	/** Test seam for the deployment backup check. */
	readonly backup?: BackupGuard;
	/** Test seam; the shipped check reads this workspace's active holds. */
	readonly holds?: LegalHoldCheck;
	/** Signs and verifies chain anchors; read from the environment by default. */
	readonly signer?: AnchorSigner;
	readonly now?: () => number;
}

export interface AuditRuntime {
	repository(): Promise<AuditRepository>;
	retention(): Promise<AuditRetentionService>;
	sweeps(): Promise<AuditSweepService>;
	exports(): Promise<AuditExportService>;
	holds(): Promise<AuditHoldService>;
	seals(): Promise<AuditSealService>;
	erasures(): Promise<AuditErasureService>;
	/**
	 * The audit.erasure.v1 adapter, for a module that composes after audit.core
	 * and registers an erase operation instead of declaring it on its data
	 * class. It is sealed by `start()`, which the platform runs after every
	 * module composed.
	 */
	readonly erasure: MutableAuditErasureRegistry;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createAuditRuntime(options: AuditRuntimeOptions): AuditRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const now = options.now ?? Date.now;
	const registry = options.dataClasses;
	const backup =
		options.backup ?? createBackupGuard(environment, workspaceRoot);
	const erasureRegistry = createErasureRegistry();
	/* Read once: a deployment that starts without the key must fail at boot and
	   not at the first seal, and the ring is a property of the process. */
	let signer: AnchorSigner | undefined = options.signer;
	let repositoryPromise: Promise<AuditRepository> | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];

	const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
		options.databases.acquire({
			namespace: 'audit.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});

	const openRepository = async (): Promise<AuditRepository> => {
		if (options.repository) return options.repository;
		/* Schema work runs on the migrator role and that lease is released before
		   the runtime one is taken, so request handling never holds a schema owner. */
		const migration = await options.databases.acquire({
			namespace: 'audit.core',
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
			await migrateAuditDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(options.purpose ?? 'runtime');
		/* The sweep finds due classes across workspaces; every class it picks is
		   read again under the workspace the routing row named. */
		const backgroundLease = await acquire('background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseAuditRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repositoryInstance = (): Promise<AuditRepository> =>
		(repositoryPromise ??= openRepository());

	/* audit.core declares its own ledgers into the platform registry like any
	   other module, so the registry has no privileged entry. It names itself
	   rather than relying on the binding, because the same runtime composes in
	   a process that hands it an unbound registry. */
	registry.declare('audit.core', auditOwnDataClasses(repositoryInstance));

	let retention: AuditRetentionService | undefined;
	let sweeps: AuditSweepService | undefined;
	let exports: AuditExportService | undefined;
	let holds: AuditHoldService | undefined;
	let seals: AuditSealService | undefined;
	let erasures: AuditErasureService | undefined;
	let disposed = false;

	const holdService = async () =>
		(holds ??= new AuditHoldService(await repositoryInstance(), now));
	const anchorSigner = () =>
		(signer ??= anchorSignerFromEnvironment(environment, workspaceRoot));

	const retentionService = async () =>
		(retention ??= new AuditRetentionService(
			await repositoryInstance(),
			registry,
			now,
		));
	const sweepService = async () => {
		if (sweeps) return sweeps;
		const service = await holdService();
		return (sweeps ??= new AuditSweepService({
			repository: await repositoryInstance(),
			registry,
			backup,
			batchSize: options.sweepBatchSize,
			intervalMs: options.sweepIntervalMs,
			now,
			holds: options.holds ?? ((input) => service.forClass(input)),
		}));
	};
	const sealService = async () =>
		(seals ??= new AuditSealService({
			repository: await repositoryInstance(),
			signer: anchorSigner(),
			environment,
			workspaceRoot,
			now,
		}));
	const erasureService = async () =>
		(erasures ??= new AuditErasureService({
			repository: await repositoryInstance(),
			holds: await holdService(),
			/* The sealed catalogue is what a run walks: every class gets an
			   outcome, and a class that declares no erase is named not erasable
			   instead of being left out of the certificate. */
			dataClasses: registry,
			adapter: erasureRegistry,
			environment,
			workspaceRoot,
			now,
		}));
	const exportService = async () =>
		(exports ??= new AuditExportService({
			repository: await repositoryInstance(),
			registry,
			retention: await retentionService(),
			backup,
			environment,
			workspaceRoot,
			platformVersion: async () =>
				options.platformVersion ?? readPlatformVersion(workspaceRoot),
			now,
		}));

	/**
	 * One background pass on its own interval. A pass never overlaps itself,
	 * and a failed pass never stops the interval: the next one finds the same
	 * work.
	 */
	const loop = (label: string, work: () => Promise<unknown>) => {
		let inFlight: Promise<void> | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		const tick = () => {
			if (disposed || inFlight) return;
			const pending = work()
				.then(() => undefined)
				.catch((error: unknown) => {
					serverLogger().error(`${label} failed`, {
						module: 'audit.core',
						err: error,
					});
				})
				.finally(() => {
					if (inFlight === pending) inFlight = undefined;
				});
			inFlight = pending;
		};
		return {
			start(intervalMs: number) {
				if (disposed || timer) return;
				tick();
				timer = setInterval(tick, intervalMs);
				timer.unref?.();
			},
			stop() {
				if (timer) clearInterval(timer);
				timer = undefined;
			},
			drain: async () => {
				await inFlight;
			},
		};
	};

	const sweepLoop = loop('retention sweep', async () =>
		(await sweepService()).tick(),
	);
	const exportLoop = loop('export run', async () =>
		(await exportService()).tick(),
	);
	const erasureLoop = loop('erasure run', async () =>
		(await erasureService()).tick(),
	);

	const stop = () => {
		sweepLoop.stop();
		exportLoop.stop();
		erasureLoop.stop();
	};

	const quiesce = async () => {
		stop();
		await sweepLoop.drain();
		await exportLoop.drain();
		await erasureLoop.drain();
	};

	return {
		repository: repositoryInstance,
		retention: retentionService,
		sweeps: sweepService,
		exports: exportService,
		holds: holdService,
		seals: sealService,
		erasures: erasureService,
		erasure: erasureRegistry,
		start() {
			if (disposed) return;
			/* The platform runs start hooks after every module composed, so this
			   is the point at which the set of erase operations is the one every
			   module agreed on; a later registration throws. */
			erasureRegistry.seal();
			/* The interval is read once here, so an edited cadence reaches the
			   loop at the next start; the setting's description says so. The
			   batch size is read per pass and changes immediately. */
			sweepLoop.start(options.sweepIntervalMs());
			exportLoop.start(EXPORT_POLL_INTERVAL_MS);
			erasureLoop.start(ERASURE_POLL_INTERVAL_MS);
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
			retention = undefined;
			sweeps = undefined;
			exports = undefined;
			holds = undefined;
			seals = undefined;
			erasures = undefined;
		},
	};
}
