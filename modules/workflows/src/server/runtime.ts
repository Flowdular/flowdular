import { createHash } from 'node:crypto';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import {
	createPlatformCapabilityRegistry,
	parsePreviousKeys,
	type PlatformCapabilityRegistry,
} from '@flowdular/kernel';
import {
	APPROVALS_REQUESTS_CAPABILITY,
	type ApprovalsRequests,
	type WorkspaceRolesResolver,
} from '../services/approvals.ts';
import { createWorkflowCursorCodec } from '../services/cursor-codec.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublisher,
} from '../services/notifications.ts';
import {
	createWorkflowPayloadCodec,
	decodeWorkflowPayloadKey,
	type WorkflowPayloadCodec,
} from '../services/payload-codec.ts';
import {
	DatabaseWorkflowsRepository,
	migrateWorkflowsDatabase,
} from '../services/database-repository.ts';
import type { WorkflowsRepository } from '../services/repository.ts';
import {
	WorkflowsService,
	type WorkflowsServiceOptions,
} from '../services/workflows-service.ts';
import {
	WorkflowWorker,
	type WorkflowWorkerOptions,
} from '../services/worker.ts';

export interface WorkflowsRuntimeOptions {
	/** Platform-owned provider. Every lease of the runtime comes from it. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	readonly repository?: WorkflowsRepository;
	readonly capabilities?: PlatformCapabilityRegistry;
	/* Roles the workspace defines, read through auth.core when a graph carries a
	   human-approval node. */
	readonly roles?: WorkspaceRolesResolver;
	readonly payloadKey?: Buffer;
	/* Keys a rotation has not finished retiring. They open stored payloads and
	   verify outstanding cursors; nothing is ever written or signed with them. */
	readonly previousPayloadKeys?: readonly Buffer[];
	readonly cursorKey?: Buffer;
	readonly previousCursorKeys?: readonly Buffer[];
	readonly payloadRetentionMs?: number;
	readonly worker?: WorkflowWorkerOptions;
	readonly environment?: NodeJS.ProcessEnv;
	readonly workspaceRoot?: string;
}

export interface WorkflowsRuntime {
	service(): Promise<WorkflowsService>;
	/* The store the declared data classes sweep, export and erase through. It
	   opens the runtime's own leases on first use, like the service does, so
	   declaring a class at composition opens no connection. */
	repository(): Promise<WorkflowsRepository>;
	start(): void;
	stop(): void | Promise<void>;
	dispose(): void | Promise<void>;
}

function derivedDevelopmentKey(workspaceRoot: string, purpose: string): Buffer {
	return createHash('sha256')
		.update(
			`flowdular-workflows-development\u0000${purpose}\u0000${workspaceRoot}`,
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
		...(!provided.payloadKey && !environment.FD_WORKFLOWS_PAYLOAD_KEY
			? ['FD_WORKFLOWS_PAYLOAD_KEY']
			: []),
		...(!provided.cursorKey && !environment.FD_WORKFLOWS_CURSOR_KEY
			? ['FD_WORKFLOWS_CURSOR_KEY']
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
): Omit<WorkflowsRuntimeOptions, 'databases'> {
	assertProductionWorkflowSecrets(environment, {
		payloadKey: false,
		cursorKey: false,
	});
	return {
		payloadKey: environment.FD_WORKFLOWS_PAYLOAD_KEY
			? decodeWorkflowPayloadKey(environment.FD_WORKFLOWS_PAYLOAD_KEY)
			: derivedDevelopmentKey(workspaceRoot, 'payload'),
		previousPayloadKeys: parsePreviousKeys(
			environment.FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS,
			(entry) =>
				decodeWorkflowPayloadKey(entry, 'FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS'),
		),
		cursorKey: environment.FD_WORKFLOWS_CURSOR_KEY
			? decodeWorkflowPayloadKey(
					environment.FD_WORKFLOWS_CURSOR_KEY,
					'FD_WORKFLOWS_CURSOR_KEY',
				)
			: derivedDevelopmentKey(workspaceRoot, 'cursor'),
		previousCursorKeys: parsePreviousKeys(
			environment.FD_WORKFLOWS_CURSOR_KEY_PREVIOUS,
			(entry) =>
				decodeWorkflowPayloadKey(entry, 'FD_WORKFLOWS_CURSOR_KEY_PREVIOUS'),
		),
		worker: {
			leaseMs: environmentInteger(
				environment.FD_WORKFLOWS_WORKER_LEASE_MS,
				30_000,
				1_000,
				300_000,
				'FD_WORKFLOWS_WORKER_LEASE_MS',
			),
			pollMs: environmentInteger(
				environment.FD_WORKFLOWS_WORKER_POLL_MS,
				1_000,
				250,
				60_000,
				'FD_WORKFLOWS_WORKER_POLL_MS',
			),
		},
		payloadRetentionMs: environmentInteger(
			environment.FD_WORKFLOWS_PAYLOAD_RETENTION_MS,
			24 * 60 * 60 * 1_000,
			0,
			30 * 24 * 60 * 60 * 1_000,
			'FD_WORKFLOWS_PAYLOAD_RETENTION_MS',
		),
		environment,
		workspaceRoot,
	};
}

/**
 * The codec a process outside the runtime seals with: the same current key and
 * retired keys the runtime itself would resolve from this environment.
 */
export function workflowPayloadCodecFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): WorkflowPayloadCodec {
	const options = workflowsRuntimeOptionsFromEnvironment(
		environment,
		workspaceRoot,
	);
	return createWorkflowPayloadCodec(
		options.payloadKey ?? derivedDevelopmentKey(workspaceRoot, 'payload'),
		options.previousPayloadKeys ?? [],
	);
}

export function createWorkflowsRuntime(
	options: WorkflowsRuntimeOptions,
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
	let repository: WorkflowsRepository | undefined;
	let servicePromise: Promise<WorkflowsService> | undefined;
	let service: WorkflowsService | undefined;
	let worker: WorkflowWorker | undefined;
	let leases: readonly DatabaseAdapterLease[] = [];
	let disposed = false;
	let started = false;

	const acquire = (
		databases: DatabaseProvider,
		purpose: DatabaseProviderRequest['purpose'],
	) =>
		databases.acquire({
			namespace: 'workflows.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});

	const openRepository = async (): Promise<WorkflowsRepository> => {
		if (options.repository) return options.repository;
		/* Migrations take their own short lease: the runtime role is tenant
		   scoped and may not run schema operations. */
		const migration = await options.databases.acquire({
			namespace: 'workflows.core',
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
			await migrateWorkflowsDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await acquire(
			options.databases,
			options.purpose ?? 'runtime',
		);
		/* The worker claim poll and payload retention read across tenants; every
		   write that follows uses the tenant carried by the row they returned. */
		const backgroundLease = await acquire(options.databases, 'background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseWorkflowsRepository(
			{
				runtime: runtimeLease.database,
				background: backgroundLease.database,
			},
			createWorkflowPayloadCodec(payloadKey, options.previousPayloadKeys ?? []),
			options.payloadRetentionMs,
		);
	};

	const create = async (): Promise<WorkflowsService> => {
		if (disposed) throw new Error('Workflows runtime is disposed.');
		repository ??= await openRepository();
		if (!service) {
			const serviceOptions: WorkflowsServiceOptions = {
				capabilities,
				cursorCodec: createWorkflowCursorCodec(
					cursorKey,
					options.previousCursorKeys ?? [],
				),
				...(options.roles ? { roles: options.roles } : {}),
				onRunQueued: () => worker?.kick(),
			};
			service = new WorkflowsService(repository, serviceOptions);
		}
		worker ??= new WorkflowWorker(
			repository,
			() => service?.executionDependencies() ?? null,
			{
				...options.worker,
				/* notifications.core is optional and is not declared as a
				   dependency. The lookup happens when a run settles, so a module
				   composed after this one is found and an absent one is a no-op. */
				notifications: () =>
					capabilities.get<NotificationPublisher>(
						NOTIFICATIONS_PUBLISH_CAPABILITY,
					),
				/* approvals.core is optional too. A human-approval node refuses with
				   a stable code when it is absent; every other node is unaffected. */
				approvals: () =>
					capabilities.get<ApprovalsRequests>(APPROVALS_REQUESTS_CAPABILITY),
			},
		);
		if (started) worker.start();
		return service;
	};

	const resolved = (): Promise<WorkflowsService> =>
		(servicePromise ??= create());

	return {
		service: resolved,
		repository: async () => {
			await resolved();
			return repository!;
		},
		start() {
			if (disposed) throw new Error('Workflows runtime is disposed.');
			started = true;
			void resolved().then(() => worker?.start());
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
			await repository?.close();
			for (const lease of leases) await lease.release();
			leases = [];
			worker = undefined;
			service = undefined;
			servicePromise = undefined;
			repository = undefined;
		},
	};
}
