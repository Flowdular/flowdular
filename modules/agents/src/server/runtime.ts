import { randomUUID } from 'node:crypto';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentProvider,
	type AgentTool,
	type AgentToolAccessAuthorizer,
} from '@coreloom/harness';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
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
import { SqliteProviderRepository } from '../services/provider-repository.ts';
import { AgentProviderBroker } from '../services/provider-broker.ts';
import { AgentProviderService } from '../services/provider-service.ts';
import {
	runGrantAuthorityFromEnvironment,
	type AgentRunGrantAuthority,
} from '../services/run-grant.ts';
import { SqliteAgentRepository } from '../services/sqlite-repository.ts';
import { AgentUsageService } from '../services/usage-service.ts';
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
	readonly databasePath: string;
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
}

export interface AgentRuntime {
	service(): AgentService;
	providerService(): AgentProviderService;
	usageService(): AgentUsageService;
	workerStatus(): AgentWorkerStatus;
	revisionExecution(): AgentRevisionExecutionCapability;
	actions(): AgentActionExecutionCapability;
	prepare(): void;
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
		databasePath:
			environment.CL_AGENTS_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/agents.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'agents.db')),
		workerConcurrency: environmentInteger(
			environment.CL_AGENT_WORKER_CONCURRENCY,
			2,
			1,
			16,
			'CL_AGENT_WORKER_CONCURRENCY',
		),
		workerLeaseMs: environmentInteger(
			environment.CL_AGENT_WORKER_LEASE_MS,
			30_000,
			1_000,
			300_000,
			'CL_AGENT_WORKER_LEASE_MS',
		),
		providerHostAllowlist: providerHostAllowlist(
			environment.CL_AGENT_PROVIDER_HOST_ALLOWLIST,
		),
		/* A human proves a model by clicking Test. A 15 minute window meant every
		   run outside that window was rejected, so the default is a day. */
		providerReadinessTtlMs: environmentInteger(
			environment.CL_AGENT_PROVIDER_READINESS_TTL_MS,
			86_400_000,
			10_000,
			86_400_000,
			'CL_AGENT_PROVIDER_READINESS_TTL_MS',
		),
		providerReadinessTimeoutMs: environmentInteger(
			environment.CL_AGENT_PROVIDER_READINESS_TIMEOUT_MS,
			10_000,
			1_000,
			30_000,
			'CL_AGENT_PROVIDER_READINESS_TIMEOUT_MS',
		),
		runGrantTtlMs: environmentInteger(
			environment.CL_AGENT_RUN_GRANT_TTL_MS,
			30_000,
			1_000,
			300_000,
			'CL_AGENT_RUN_GRANT_TTL_MS',
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
		...(!provided.credentialVault && !environment.CL_AGENT_CREDENTIAL_KEY
			? ['CL_AGENT_CREDENTIAL_KEY']
			: []),
		...(!provided.runGrantAuthority && !environment.CL_AGENT_RUN_GRANT_KEY
			? ['CL_AGENT_RUN_GRANT_KEY']
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
	let repository: SqliteAgentRepository | undefined;
	let providerRepository: SqliteProviderRepository | undefined;
	let actionRuntime: AgentActionRuntime | undefined;
	let started = false;
	let disposed = false;
	let moduleAgentsReconciled = false;
	let preparedModuleAgents: readonly ModuleAgentDefinition[] | undefined;
	const moduleAgents = () =>
		typeof options.moduleAgents === 'function'
			? options.moduleAgents()
			: (options.moduleAgents ?? []);
	const prepare = () => {
		if (disposed) throw new Error('Agent runtime is disposed.');
		preparedModuleAgents = preflightModuleAgentDefinitions(
			options.databasePath,
			moduleAgents(),
		);
	};
	const create = () => {
		if (disposed) throw new Error('Agent runtime is disposed.');
		if (!service) {
			repository = new SqliteAgentRepository(options.databasePath);
			providerRepository = new SqliteProviderRepository(options.databasePath);
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
			);
			actionRuntime = createAgentActionExecutionRuntime(repository, tools, {
				leaseMs: options.workerLeaseMs,
				...(options.authorizeToolAccess
					? { authorizeToolAccess: options.authorizeToolAccess }
					: {}),
			});
		}
		return service;
	};
	const start = () => {
		const currentService = create();
		if (started) return;
		if (!moduleAgentsReconciled) {
			currentService.reconcileModuleAgents(
				preparedModuleAgents ?? moduleAgents(),
			);
			moduleAgentsReconciled = true;
		}
		started = true;
		worker!.start();
		actionRuntime!.start();
	};
	const revisionCapability = createAgentRevisionExecutionCapability(
		() => create(),
		options.authorizeToolAccess,
	);
	const currentActions = () => {
		void create();
		return actionRuntime!.capability;
	};
	const actionCapability: AgentActionExecutionCapability = {
		listWorkflowActions: () => currentActions().listWorkflowActions(),
		start: (request, context) => currentActions().start(request, context),
		getResult: (id, context) => currentActions().getResult(id, context),
		requestCancel: (id, context) => currentActions().requestCancel(id, context),
	};
	const quiesce = async () => {
		started = false;
		await worker?.dispose();
		await actionRuntime?.dispose();
	};
	return {
		service: create,
		providerService: () => {
			void create();
			return providers!;
		},
		usageService: () => {
			void create();
			return usage!;
		},
		workerStatus: () => {
			void create();
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
			providerRepository?.close();
			repository?.close();
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
