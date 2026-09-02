import type { PlatformVariableRegistry } from '@coreloom/kernel';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import type { AgentRunQueue } from '@coreloom/module-agents/server';
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
import { SqliteAutomationsRepository } from '../services/sqlite-repository.ts';
import { AutomationTriggerService } from '../services/trigger-service.ts';

export interface AutomationsRuntimeOptions {
	readonly databasePath: string;
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
	scheduleService(): AutomationScheduleService;
	triggerService(): AutomationTriggerService;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): readonly AutomationAuditEvent[];
	verifyAudit(tenantId: string): AutomationAuditVerification;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function automationsRuntimeOptionsFromEnvironment(
	runQueue: () => AgentRunQueue,
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): AutomationsRuntimeOptions {
	return {
		databasePath:
			environment.CL_AUTOMATIONS_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/automations.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'automations.db')),
		runQueue,
		environment,
		workspaceRoot,
	};
}

export function createAutomationsRuntime(
	options: AutomationsRuntimeOptions,
): AutomationsRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	let repository = options.repository;
	const repositoryInstance = () =>
		(repository ??= new SqliteAutomationsRepository(options.databasePath));
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
	const scheduleService = () =>
		(schedules ??= new AutomationScheduleService(
			repositoryInstance(),
			options.runQueue(),
			Date.now,
			resolutionController.signal,
			options.variables,
			targets,
		));
	const triggerService = () =>
		(triggers ??= new AutomationTriggerService(
			repositoryInstance(),
			vault,
			options.runQueue(),
			Date.now,
			undefined,
			targets,
		));
	const tick = () => {
		if (disposed || tickInFlight) return;
		const pending = scheduleService()
			.tick()
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
		listAuditEvents: (tenantId, limit) =>
			repositoryInstance().listAuditEvents(
				tenantId,
				Math.min(Math.max(1, limit), 200),
			),
		verifyAudit: (tenantId) => repositoryInstance().verifyAuditChain(tenantId),
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
			const closable = repository as { close?: () => void } | undefined;
			closable?.close?.();
			repository = undefined;
			schedules = undefined;
			triggers = undefined;
		},
	};
}
