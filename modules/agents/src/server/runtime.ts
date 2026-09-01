import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentProvider,
	type AgentTool,
} from '@coreloom/harness';
import type { AgentWorkerStatus } from '../domain/types.ts';
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
import { AgentWorker } from '../services/worker.ts';
import type { AgentSettingsReader } from '../settings.ts';

export interface AgentRuntimeOptions {
	readonly databasePath: string;
	readonly workerConcurrency: number;
	readonly workerLeaseMs: number;
	readonly providers?: readonly AgentProvider[];
	/* A function is evaluated when the harness is first built, so tools that
	   other modules register after this runtime was created are included. */
	readonly tools?: readonly AgentTool[] | (() => readonly AgentTool[]);
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
	workerStatus(): AgentWorkerStatus;
	start(): void;
	stop(): void;
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
			environment.OERP_AGENTS_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/agents.db'
				: resolve(workspaceRoot, '.octane-erp/agents.db')),
		workerConcurrency: environmentInteger(
			environment.OERP_AGENT_WORKER_CONCURRENCY,
			2,
			1,
			16,
			'OERP_AGENT_WORKER_CONCURRENCY',
		),
		workerLeaseMs: environmentInteger(
			environment.OERP_AGENT_WORKER_LEASE_MS,
			30_000,
			1_000,
			300_000,
			'OERP_AGENT_WORKER_LEASE_MS',
		),
		providerHostAllowlist: providerHostAllowlist(
			environment.OERP_AGENT_PROVIDER_HOST_ALLOWLIST,
		),
		/* A human proves a model by clicking Test. A 15 minute window meant every
		   run outside that window was rejected, so the default is a day. */
		providerReadinessTtlMs: environmentInteger(
			environment.OERP_AGENT_PROVIDER_READINESS_TTL_MS,
			86_400_000,
			10_000,
			86_400_000,
			'OERP_AGENT_PROVIDER_READINESS_TTL_MS',
		),
		providerReadinessTimeoutMs: environmentInteger(
			environment.OERP_AGENT_PROVIDER_READINESS_TIMEOUT_MS,
			10_000,
			1_000,
			30_000,
			'OERP_AGENT_PROVIDER_READINESS_TIMEOUT_MS',
		),
		runGrantTtlMs: environmentInteger(
			environment.OERP_AGENT_RUN_GRANT_TTL_MS,
			30_000,
			1_000,
			300_000,
			'OERP_AGENT_RUN_GRANT_TTL_MS',
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
		...(!provided.credentialVault && !environment.OERP_AGENT_CREDENTIAL_KEY
			? ['OERP_AGENT_CREDENTIAL_KEY']
			: []),
		...(!provided.runGrantAuthority && !environment.OERP_AGENT_RUN_GRANT_KEY
			? ['OERP_AGENT_RUN_GRANT_KEY']
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
	let started = false;
	const create = () => {
		if (!service) {
			const repository = new SqliteAgentRepository(options.databasePath);
			const providerRepository = new SqliteProviderRepository(
				options.databasePath,
			);
			const harness = new AgentHarness({
				providers: options.providers ?? [new LocalSimulationProvider()],
				tools:
					typeof options.tools === 'function'
						? options.tools()
						: (options.tools ?? []),
			});
			const providerService = new AgentProviderService(
				providerRepository,
				options.credentialVault ??
					credentialVaultFromEnvironment(environment, workspaceRoot),
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
			);
		}
		if (!started) {
			started = true;
			worker!.start();
		}
		return service;
	};
	return {
		service: create,
		providerService: () => {
			void create();
			return providers!;
		},
		workerStatus: () => {
			void create();
			return worker!.status();
		},
		start: () => void create(),
		stop: () => {
			started = false;
			worker?.stop();
		},
	};
}
