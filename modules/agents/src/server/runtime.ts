import { randomUUID } from 'node:crypto';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentProvider,
	type AgentTool,
	type AgentToolAccessAuthorizer,
} from '@flowdular/harness';
import type {
	AgentWorkerStatus,
	ModuleAgentDefinition,
} from '../domain/types.ts';
import { AgentService } from '../services/agent-service.ts';
import {
	credentialVaultFromEnvironment,
	type CredentialVault,
} from '../services/credential-vault.ts';
import { providerHostAllowlist } from '../services/outbound-policy.ts';
import {
	DatabaseProviderRepository,
	type ProviderRepository,
} from '../services/provider-repository.ts';
import { AgentProviderBroker } from '../services/provider-broker.ts';
import { AgentProviderService } from '../services/provider-service.ts';
import {
	runGrantAuthorityFromEnvironment,
	type AgentRunGrantAuthority,
} from '../services/run-grant.ts';
import {
	DatabaseAgentRepository,
	migrateAgentsDatabase,
} from '../services/database-repository.ts';
import type { NotificationPublisherResolver } from '../services/notifications.ts';
import type { MeterRegistryResolver } from '../services/metering.ts';
import type { AgentRepository } from '../services/repository.ts';
import { AgentUsageService } from '../services/usage-service.ts';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import { serverTracer, type Tracer } from '@flowdular/server';
import { preflightModuleAgentDefinitions } from '../services/module-agent-preflight.ts';
import { AgentWorker } from '../services/worker.ts';
import type { AgentSettingsReader } from '../settings.ts';
import {
	createAgentActionExecutionRuntime,
	type AgentActionExecutionCapability,
	type AgentActionRuntime,
} from './action-execution.ts';
import {
	createAgentRevisionExecutionCapability,
	type AgentRevisionExecutionCapability,
} from './run-execution.ts';

export interface AgentRuntimeOptions {
	readonly workerConcurrency: number;
	readonly workerLeaseMs: number;
	readonly providers?: readonly AgentProvider[];
	/* A function is evaluated when the harness is first built, so tools that
	   other modules register after this runtime was created are included. */
	readonly tools?: readonly AgentTool[] | (() => readonly AgentTool[]);
	/* Read at start after the platform seals the composition registry. */
	readonly moduleAgents?:
		| readonly ModuleAgentDefinition[]
		| (() => readonly ModuleAgentDefinition[]);
	readonly authorizeToolAccess?: AgentToolAccessAuthorizer;
	readonly credentialVault?: CredentialVault;
	readonly providerHostAllowlist: ReadonlySet<string>;
	readonly providerReadinessTtlMs: number;
	readonly providerReadinessTimeoutMs: number;
	readonly runGrantAuthority?: AgentRunGrantAuthority;
	readonly runGrantTtlMs: number;
	/* Where the encryption and signing keys come from. Defaults to the
	   process when a caller builds options by hand. */
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
	/* Live admin settings. Absent means the options above are final. */
	readonly settings?: AgentSettingsReader;
	/* Resolves the optional notifications publisher when a run settles, never
	   at composition time: the platform may compose notifications.core after
	   agents.core, or not at all. */
	readonly notifications?: NotificationPublisherResolver;
	/* Resolves the meter registry when a run starts and when it settles, so
	   both read the registry the platform holds then. Absent only in a process
	   that built the runtime outside the module composition, such as a test. */
	readonly meters?: MeterRegistryResolver;
	/** Platform-owned provider. Composition passes this instead of a path. */
	readonly databases?: DatabaseProvider | undefined;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	/**
	 * Spans for provider and tool calls. Defaults to the process tracer, which
	 * is the one `context.tracer` carries, so a run joins the trace of whatever
	 * started it.
	 */
	readonly tracer?: Tracer;
}

export interface AgentRuntime {
	service(): Promise<AgentService>;
	/* The store the declared data classes sweep, export and erase through. It
	   opens the runtime's own leases on first use, like every other accessor
	   here, so declaring a class at composition opens no connection. */
	repository(): Promise<AgentRepository>;
	providerService(): Promise<AgentProviderService>;
	usageService(): Promise<AgentUsageService>;
	workerStatus(): Promise<AgentWorkerStatus>;
	revisionExecution(): AgentRevisionExecutionCapability;
	actions(): AgentActionExecutionCapability;
	prepare(): Promise<void>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

function environmentInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return parsed;
}

export function agentRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): AgentRuntimeOptions {
	return {
		workerConcurrency: environmentInteger(
			environment.FD_AGENT_WORKER_CONCURRENCY,
			2,
			1,
			16,
			'FD_AGENT_WORKER_CONCURRENCY',
		),
		workerLeaseMs: environmentInteger(
			environment.FD_AGENT_WORKER_LEASE_MS,
			30_000,
			1_000,
			300_000,
			'FD_AGENT_WORKER_LEASE_MS',
		),
		providerHostAllowlist: providerHostAllowlist(
			environment.FD_AGENT_PROVIDER_HOST_ALLOWLIST,
		),
		/* A human proves a model by clicking Test. A 15 minute window meant every
		   run outside that window was rejected, so the default is a day. */
		providerReadinessTtlMs: environmentInteger(
			environment.FD_AGENT_PROVIDER_READINESS_TTL_MS,
			86_400_000,
			10_000,
			86_400_000,
			'FD_AGENT_PROVIDER_READINESS_TTL_MS',
		),
		providerReadinessTimeoutMs: environmentInteger(
			environment.FD_AGENT_PROVIDER_READINESS_TIMEOUT_MS,
			10_000,
			1_000,
			30_000,
			'FD_AGENT_PROVIDER_READINESS_TIMEOUT_MS',
		),
		runGrantTtlMs: environmentInteger(
			environment.FD_AGENT_RUN_GRANT_TTL_MS,
			30_000,
			1_000,
			300_000,
			'FD_AGENT_RUN_GRANT_TTL_MS',
		),
		environment,
		workspaceRoot,
	};
}

/* Production has no key file fallback. Missing keys must stop the boot,
   not surface as a 500 on the first provider request hours later. */
export function assertProductionAgentSecrets(
	environment: NodeJS.ProcessEnv,
	provided: {
		readonly credentialVault: boolean;
		readonly runGrantAuthority: boolean;
	},
): void {
	if (environment.NODE_ENV !== 'production') return;
	const missing = [
		...(!provided.credentialVault && !environment.FD_AGENT_CREDENTIAL_KEY
			? ['FD_AGENT_CREDENTIAL_KEY']
			: []),
		...(!provided.runGrantAuthority && !environment.FD_AGENT_RUN_GRANT_KEY
			? ['FD_AGENT_RUN_GRANT_KEY']
			: []),
	];
	if (missing.length === 0) return;
	throw new Error(
		`agents.core cannot start in production: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Provide base64-encoded 32-byte keys (for example: openssl rand -base64 32) through the deployment's secrets.`,
	);
}

export function createAgentRuntime(
	options: AgentRuntimeOptions = agentRuntimeOptionsFromEnvironment(),
): AgentRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	assertProductionAgentSecrets(environment, {
		credentialVault: options.credentialVault !== undefined,
		runGrantAuthority: options.runGrantAuthority !== undefined,
	});
	const settings = options.settings;
	let service: AgentService | undefined;
	let worker: AgentWorker | undefined;
	let providers: AgentProviderService | undefined;
	let usage: AgentUsageService | undefined;
	let repository: AgentRepository | undefined;
	let providerRepository: ProviderRepository | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];
	let servicePromise: Promise<AgentService> | undefined;
	let actionRuntime: AgentActionRuntime | undefined;
	let started = false;
	let disposed = false;
	let moduleAgentsReconciled = false;
	let preparedModuleAgents: readonly ModuleAgentDefinition[] | undefined;
	const moduleAgents = () =>
		typeof options.moduleAgents === 'function'
			? options.moduleAgents()
			: (options.moduleAgents ?? []);
	const prepare = async () => {
		if (disposed) throw new Error('Agent runtime is disposed.');
		preparedModuleAgents = await preflightModuleAgentDefinitions(
			options.databases,
			moduleAgents(),
		);
	};
	const acquire = (
		databases: DatabaseProvider,
		purpose: DatabaseProviderRequest['purpose'],
	) =>
		databases.acquire({
			namespace: 'agents.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});

	const openRepositories = async () => {
		if (!options.databases) {
			throw new Error(
				'agents.core requires a platform database provider; there is no local file fallback.',
			);
		}
		/* Only schema work receives the migration role. Reconciliation uses
		   tenant-scoped runtime transactions after this lease is released. */
		const migration = await options.databases.acquire({
			namespace: 'agents.core',
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
			await migrateAgentsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(
			options.databases,
			options.purpose ?? 'runtime',
		);
		leases = [runtimeLease];
		/* The worker recovery polls read across tenants; every claim that
		   follows uses the tenant carried by the row they returned. */
		const backgroundLease = await acquire(options.databases, 'background');
		leases = [runtimeLease, backgroundLease];
		const agents = new DatabaseAgentRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
		await agents.adoptCurrentAgentRevisions();
		return {
			repository: agents as AgentRepository,
			providerRepository: new DatabaseProviderRepository(
				runtimeLease.database,
				Promise.resolve(),
				backgroundLease.database,
			) as ProviderRepository,
		};
	};

	const create = async (): Promise<AgentService> => {
		if (disposed) throw new Error('Agent runtime is disposed.');
		if (!service) {
			const opened = await openRepositories();
			repository = opened.repository;
			providerRepository = opened.providerRepository;
			const vault =
				options.credentialVault ??
				credentialVaultFromEnvironment(environment, workspaceRoot);
			const tools =
				typeof options.tools === 'function'
					? options.tools()
					: (options.tools ?? []);
			const harness = new AgentHarness({
				providers: options.providers ?? [new LocalSimulationProvider()],
				tools,
				tracer: options.tracer ?? serverTracer(),
				...(options.authorizeToolAccess
					? { authorizeToolAccess: options.authorizeToolAccess }
					: {}),
			});
			const providerService = new AgentProviderService(
				providerRepository,
				vault,
				repository,
				{
					hostAllowlist: settings
						? () => settings.providerHostAllowlist()
						: options.providerHostAllowlist,
					readinessTtlMs: settings
						? () => settings.providerReadinessTtlMs()
						: options.providerReadinessTtlMs,
					readinessTimeoutMs: options.providerReadinessTimeoutMs,
				},
			);
			providers = providerService;
			const runGrantAuthority =
				options.runGrantAuthority ??
				runGrantAuthorityFromEnvironment(
					environment,
					workspaceRoot,
					options.runGrantTtlMs,
				);
			const providerBroker = new AgentProviderBroker(
				runGrantAuthority,
				repository,
				providerService,
			);
			const usageService = new AgentUsageService(repository, settings);
			usage = usageService;
			worker = new AgentWorker(
				repository,
				harness,
				{
					workerId: `agent-worker:${process.pid}:${randomUUID()}`,
					concurrency: settings
						? () => settings.workerConcurrency()
						: options.workerConcurrency,
					leaseMs: settings?.workerLeaseMs() ?? options.workerLeaseMs,
					runGrantAuthority,
					providerBroker,
					...(options.notifications
						? { notifications: options.notifications }
						: {}),
					...(options.meters ? { meters: options.meters } : {}),
				},
				providerService,
			);
			service = new AgentService(
				repository,
				harness,
				worker,
				providerService,
				Date.now,
				settings,
				usageService,
				options.meters,
			);
			actionRuntime = createAgentActionExecutionRuntime(repository, tools, {
				leaseMs: options.workerLeaseMs,
				...(options.tracer ? { tracer: options.tracer } : {}),
				...(options.authorizeToolAccess
					? { authorizeToolAccess: options.authorizeToolAccess }
					: {}),
			});
		}
		return service;
	};
	const resolved = (): Promise<AgentService> => (servicePromise ??= create());
	const start = () => {
		if (started) return;
		started = true;
		void resolved().then(async (currentService) => {
			if (!moduleAgentsReconciled) {
				await currentService.reconcileModuleAgents(
					preparedModuleAgents ?? moduleAgents(),
				);
				moduleAgentsReconciled = true;
			}
			worker!.start();
			actionRuntime!.start();
		});
	};
	const revisionCapability = createAgentRevisionExecutionCapability(
		() => resolved(),
		options.authorizeToolAccess,
	);
	const currentActions = async () => {
		await resolved();
		return actionRuntime!.capability;
	};
	const actionCapability: AgentActionExecutionCapability = {
		listWorkflowActions: async () =>
			(await currentActions()).listWorkflowActions(),
		start: async (request, context) =>
			(await currentActions()).start(request, context),
		getResult: async (id, context) =>
			(await currentActions()).getResult(id, context),
		requestCancel: async (id, context) =>
			(await currentActions()).requestCancel(id, context),
	};
	const quiesce = async () => {
		started = false;
		await worker?.dispose();
		await actionRuntime?.dispose();
	};
	return {
		service: resolved,
		repository: async () => {
			await resolved();
			return repository!;
		},
		providerService: async () => {
			await resolved();
			return providers!;
		},
		usageService: async () => {
			await resolved();
			return usage!;
		},
		workerStatus: async () => {
			await resolved();
			return worker!.status();
		},
		revisionExecution: () => revisionCapability,
		actions: () => actionCapability,
		prepare,
		start,
		stop: () => {
			started = false;
			worker?.stop();
			actionRuntime?.stop();
		},
		quiesce,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await quiesce();
			await providerRepository?.close();
			await repository?.close();
			for (const lease of leases) await lease.release();
			leases = [];
			servicePromise = undefined;
			worker = undefined;
			actionRuntime = undefined;
			providers = undefined;
			usage = undefined;
			service = undefined;
			providerRepository = undefined;
			repository = undefined;
		},
	};
}
