import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { PlatformVariableRegistry } from '@flowdular/kernel';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import {
	createAutomationTargetRegistry,
	type AutomationTargetRegistry,
} from './targets.ts';
import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
} from '../domain/types.ts';
import type { AutomationsRepository } from '../services/repository.ts';
import { AutomationScheduleService } from '../services/schedule-service.ts';
import {
	secretVaultFromEnvironment,
	type SecretVault,
} from '../services/secret-vault.ts';
import {
	DatabaseAutomationsRepository,
	migrateAutomationsDatabase,
} from '../services/database-repository.ts';
import { AutomationTriggerService } from '../services/trigger-service.ts';

export interface AutomationsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	readonly runQueue: () => AgentRunQueue;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
	readonly secretVault?: SecretVault;
	readonly schedulerPollMs?: number | (() => number);
	readonly repository?: AutomationsRepository;
	readonly variables?: PlatformVariableRegistry;
	readonly targets?: AutomationTargetRegistry;
}

export interface AutomationsRuntime {
	scheduleService(): Promise<AutomationScheduleService>;
	triggerService(): Promise<AutomationTriggerService>;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AutomationAuditEvent[]>;
	verifyAudit(tenantId: string): Promise<AutomationAuditVerification>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

/* Everything a deployment reads from its environment. The provider itself is
   platform owned, so composition supplies `databases` alongside this. */
export function automationsRuntimeOptionsFromEnvironment(
	runQueue: () => AgentRunQueue,
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): Omit<AutomationsRuntimeOptions, 'databases'> {
	return { runQueue, environment, workspaceRoot };
}

export function createAutomationsRuntime(
	options: AutomationsRuntimeOptions,
): AutomationsRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	let repositoryPromise: Promise<AutomationsRepository> | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];
	const acquire = (
		databases: DatabaseProvider,
		purpose: DatabaseProviderRequest['purpose'],
	) =>
		databases.acquire({
			namespace: 'automations.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
	const openRepository = async (): Promise<AutomationsRepository> => {
		if (options.repository) return options.repository;
		/* Migrations take their own short lease: the runtime role is tenant
		   scoped and may not run schema operations. */
		const migration = await options.databases.acquire({
			namespace: 'automations.core',
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
			await migrateAutomationsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(
			options.databases,
			options.purpose ?? 'runtime',
		);
		/* The scheduler poll and the webhook lookup read across tenants; every
		   write that follows uses the tenant carried by the row they returned. */
		const backgroundLease = await acquire(options.databases, 'background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseAutomationsRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};
	const repositoryInstance = (): Promise<AutomationsRepository> =>
		(repositoryPromise ??= openRepository());
	const vault =
		options.secretVault ??
		secretVaultFromEnvironment(environment, workspaceRoot);
	const targets = options.targets ?? createAutomationTargetRegistry();
	let schedules: AutomationScheduleService | undefined;
	let triggers: AutomationTriggerService | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let tickInFlight: Promise<void> | undefined;
	const resolutionController = new AbortController();
	let disposed = false;
	const scheduleService = async () =>
		(schedules ??= new AutomationScheduleService(
			await repositoryInstance(),
			options.runQueue(),
			Date.now,
			resolutionController.signal,
			options.variables,
			targets,
		));
	const triggerService = async () =>
		(triggers ??= new AutomationTriggerService(
			await repositoryInstance(),
			vault,
			options.runQueue(),
			Date.now,
			undefined,
			targets,
		));
	const tick = () => {
		if (disposed || tickInFlight) return;
		const pending = scheduleService()
			.then((service) => service.tick())
			.then(() => undefined)
			.catch((error: unknown) => {
				console.error(
					'[automations] scheduler tick failed:',
					error instanceof Error ? error.message : error,
				);
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
		resolutionController.abort('automations-runtime-stopped');
		await tickInFlight;
	};
	return {
		scheduleService,
		triggerService,
		listAuditEvents: async (tenantId, limit) =>
			(await repositoryInstance()).listAuditEvents(
				tenantId,
				Math.min(Math.max(1, limit), 200),
			),
		verifyAudit: async (tenantId) =>
			(await repositoryInstance()).verifyAuditChain(tenantId),
		start() {
			if (disposed) return;
			if (poll) return;
			tick();
			const pollMs =
				typeof options.schedulerPollMs === 'function'
					? options.schedulerPollMs()
					: (options.schedulerPollMs ?? 30_000);
			poll = setInterval(tick, pollMs);
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
			schedules = undefined;
			triggers = undefined;
		},
	};
}
