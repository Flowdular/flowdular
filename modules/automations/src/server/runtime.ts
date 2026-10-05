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
	ModuleSettingsRuntime,
	PlatformVariableRegistry,
} from '@flowdular/kernel';
import type { AgentRunQueue } from '@flowdular/module-agents/server';
import type { JobRunner } from '@flowdular/server';
import {
	createAutomationTargetRegistry,
	type AutomationTargetRegistry,
} from './targets.ts';
import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
} from '../domain/types.ts';
import type { AutomationsRepository } from '../services/repository.ts';
import { createAutomationScheduleRunner } from '../services/schedule-runner.ts';
import { AutomationScheduleService } from '../services/schedule-service.ts';
import { createTimeZoneFollower } from '../services/time-zone-follower.ts';
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
	/** The workspace zone and its change log. Absent, every cron slot is UTC. */
	readonly settings?: ModuleSettingsRuntime;
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
	/** Opens the repository, for the data class operations the module owns. */
	repository(): Promise<AutomationsRepository>;
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
		leases = [runtimeLease];
		/* The scheduler poll and the webhook lookup read across tenants; every
		   write that follows uses the tenant carried by the row they returned. */
		const backgroundLease = await acquire(options.databases, 'background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseAutomationsRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};
	/* A failed open keeps nothing, not even its rejection, so the next caller
	   (a later worker tick on the same composition) opens again. */
	const repositoryInstance = (): Promise<AutomationsRepository> =>
		(repositoryPromise ??= openRepository().catch(async (error: unknown) => {
			const held = leases;
			leases = [];
			repositoryPromise = undefined;
			for (const lease of held) await lease.release();
			throw error;
		}));
	const vault =
		options.secretVault ??
		secretVaultFromEnvironment(environment, workspaceRoot);
	const targets = options.targets ?? createAutomationTargetRegistry();
	let schedules: AutomationScheduleService | undefined;
	let triggers: AutomationTriggerService | undefined;
	let jobs: JobRunner | undefined;
	let resolutionController = new AbortController();
	let disposed = false;
	const scheduleService = async () =>
		(schedules ??= new AutomationScheduleService(
			await repositoryInstance(),
			options.runQueue(),
			Date.now,
			resolutionController.signal,
			options.variables,
			targets,
			options.settings,
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
	/* The platform runner owns the loop: the interval and its unref, the guard
	   against overlapping passes, the bound on claims, the isolation of one
	   schedule from the next and the drain. This module keeps its cross-tenant
	   poll, the re-read under the workspace and the slot advance. The interval is
	   a live setting read when the loop starts, so the runner is built there
	   rather than while the composition is assembled. Zone changes are retimed
	   inside the pass, so its drain covers them too. */
	const settings = options.settings;
	const runner = (): JobRunner =>
		(jobs ??= createAutomationScheduleRunner({
			repository: repositoryInstance,
			service: scheduleService,
			timeZones: settings
				? createTimeZoneFollower({
						settings,
						apply: async (change) =>
							(await scheduleService()).applyTimeZoneChange(change),
					})
				: undefined,
			intervalMs:
				typeof options.schedulerPollMs === 'function'
					? options.schedulerPollMs()
					: (options.schedulerPollMs ?? 30_000),
		}));
	const stop = () => {
		jobs?.stop();
	};
	const quiesce = async () => {
		stop();
		resolutionController.abort('automations-runtime-stopped');
		/* Work in flight keeps the aborted signal; a later start, or a request
		   this process still serves, resolves through a service with a live one. */
		resolutionController = new AbortController();
		schedules = undefined;
		await jobs?.quiesce();
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
		repository: repositoryInstance,
		start() {
			if (disposed) return;
			runner().start();
		},
		stop,
		quiesce,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await quiesce();
			await jobs?.dispose();
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
