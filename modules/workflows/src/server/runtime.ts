import { createHash } from 'node:crypto';
import {
	createPlatformCapabilityRegistry,
	type PlatformCapabilityRegistry,
} from '@coreloom/kernel';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { createWorkflowCursorCodec } from '../services/cursor-codec.ts';
import {
	createWorkflowPayloadCodec,
	decodeWorkflowPayloadKey,
} from '../services/payload-codec.ts';
import { SqliteWorkflowsRepository } from '../services/sqlite-repository.ts';
import {
	WorkflowsService,
	type WorkflowsServiceOptions,
} from '../services/workflows-service.ts';
import {
	WorkflowWorker,
	type WorkflowWorkerOptions,
} from '../services/worker.ts';

export interface WorkflowsRuntimeOptions {
	readonly databasePath: string;
	readonly capabilities?: PlatformCapabilityRegistry;
	readonly payloadKey?: Buffer;
	readonly cursorKey?: Buffer;
	readonly payloadRetentionMs?: number;
	readonly worker?: WorkflowWorkerOptions;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
}

export interface WorkflowsRuntime {
	service(): WorkflowsService;
	start(): void;
	stop(): void | Promise<void>;
	dispose(): void | Promise<void>;
}

function derivedDevelopmentKey(workspaceRoot: string, purpose: string): Buffer {
	return createHash('sha256')
		.update(
			`coreloom-workflows-development\u0000${purpose}\u0000${workspaceRoot}`,
		)
		.digest();
}

function environmentInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return parsed;
}

export function assertProductionWorkflowSecrets(
	environment: NodeJS.ProcessEnv,
	provided: { readonly payloadKey: boolean; readonly cursorKey: boolean },
): void {
	if (environment.NODE_ENV !== 'production') return;
	const missing = [
		...(!provided.payloadKey && !environment.CL_WORKFLOWS_PAYLOAD_KEY
			? ['CL_WORKFLOWS_PAYLOAD_KEY']
			: []),
		...(!provided.cursorKey && !environment.CL_WORKFLOWS_CURSOR_KEY
			? ['CL_WORKFLOWS_CURSOR_KEY']
			: []),
	];
	if (missing.length > 0) {
		throw new Error(
			`workflows.core cannot start in production: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. Provide base64-encoded 32-byte keys through deployment secrets.`,
		);
	}
}

export function workflowsRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): WorkflowsRuntimeOptions {
	assertProductionWorkflowSecrets(environment, {
		payloadKey: false,
		cursorKey: false,
	});
	return {
		databasePath:
			environment.CL_WORKFLOWS_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/workflows.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'workflows.db')),
		payloadKey: environment.CL_WORKFLOWS_PAYLOAD_KEY
			? decodeWorkflowPayloadKey(environment.CL_WORKFLOWS_PAYLOAD_KEY)
			: derivedDevelopmentKey(workspaceRoot, 'payload'),
		cursorKey: environment.CL_WORKFLOWS_CURSOR_KEY
			? decodeWorkflowPayloadKey(environment.CL_WORKFLOWS_CURSOR_KEY)
			: derivedDevelopmentKey(workspaceRoot, 'cursor'),
		worker: {
			leaseMs: environmentInteger(
				environment.CL_WORKFLOWS_WORKER_LEASE_MS,
				30_000,
				1_000,
				300_000,
				'CL_WORKFLOWS_WORKER_LEASE_MS',
			),
			pollMs: environmentInteger(
				environment.CL_WORKFLOWS_WORKER_POLL_MS,
				1_000,
				250,
				60_000,
				'CL_WORKFLOWS_WORKER_POLL_MS',
			),
		},
		payloadRetentionMs: environmentInteger(
			environment.CL_WORKFLOWS_PAYLOAD_RETENTION_MS,
			24 * 60 * 60 * 1_000,
			0,
			30 * 24 * 60 * 60 * 1_000,
			'CL_WORKFLOWS_PAYLOAD_RETENTION_MS',
		),
		environment,
		workspaceRoot,
	};
}

export function createWorkflowsRuntime(
	options: WorkflowsRuntimeOptions = workflowsRuntimeOptionsFromEnvironment(),
): WorkflowsRuntime {
	const environment = options.environment ?? process.env;
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	assertProductionWorkflowSecrets(environment, {
		payloadKey: options.payloadKey !== undefined,
		cursorKey: options.cursorKey !== undefined,
	});
	const payloadKey =
		options.payloadKey ?? derivedDevelopmentKey(workspaceRoot, 'payload');
	const cursorKey =
		options.cursorKey ?? derivedDevelopmentKey(workspaceRoot, 'cursor');
	const capabilities =
		options.capabilities ?? createPlatformCapabilityRegistry();
	let repository: SqliteWorkflowsRepository | undefined;
	let service: WorkflowsService | undefined;
	let worker: WorkflowWorker | undefined;
	let disposed = false;
	let started = false;
	const create = () => {
		if (disposed) throw new Error('Workflows runtime is disposed.');
		repository ??= new SqliteWorkflowsRepository(
			options.databasePath,
			createWorkflowPayloadCodec(payloadKey),
			options.payloadRetentionMs,
		);
		if (!service) {
			const serviceOptions: WorkflowsServiceOptions = {
				capabilities,
				cursorCodec: createWorkflowCursorCodec(cursorKey),
				onRunQueued: () => worker?.kick(),
			};
			service = new WorkflowsService(repository, serviceOptions);
		}
		worker ??= new WorkflowWorker(
			repository,
			() => service?.executionDependencies() ?? null,
			options.worker,
		);
		if (started) worker.start();
		return service;
	};
	return {
		service: create,
		start() {
			if (disposed) throw new Error('Workflows runtime is disposed.');
			started = true;
			create();
			worker!.start();
		},
		stop() {
			started = false;
			return worker?.stop() ?? undefined;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const pending = worker?.stop();
			if (pending) await pending;
			const close = () => {
				repository?.close();
				worker = undefined;
				service = undefined;
				repository = undefined;
			};
			close();
		},
	};
}
