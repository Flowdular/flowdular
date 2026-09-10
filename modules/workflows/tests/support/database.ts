import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseHandle,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	createWorkflowsRuntime,
	type WorkflowsRuntime,
	type WorkflowsRuntimeOptions,
} from '../../src/server/runtime.ts';
import {
	DatabaseWorkflowsRepository,
	migrateWorkflowsDatabase,
} from '../../src/services/database-repository.ts';
import {
	createWorkflowPayloadCodec,
	type WorkflowPayloadCodec,
} from '../../src/services/payload-codec.ts';

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
	],
} as const;

function request(
	purpose: DatabaseProviderRequest['purpose'],
): DatabaseProviderRequest {
	return { namespace: 'workflows.core', purpose, requirements: REQUIREMENTS };
}

/** An embedded PostgreSQL with the real runtime and background roles. */
export function createWorkflowsTestProvider(): DatabaseProvider {
	return createTestDatabaseProvider();
}

export interface WorkflowsTestRepository {
	readonly repository: DatabaseWorkflowsRepository;
	readonly databases: DatabaseProvider;
	dispose(): Promise<void>;
}

export interface WorkflowsTestRepositoryOptions {
	readonly payloadCodec?: WorkflowPayloadCodec | undefined;
	readonly payloadRetentionMs?: number | undefined;
}

/**
 * The module schema on an embedded PostgreSQL, with the tenant-scoped runtime
 * role for request-time work and the read-only background role for the
 * cross-tenant claim poll and payload retention.
 */
export async function openWorkflowsTestRepository(
	options: WorkflowsTestRepositoryOptions = {},
): Promise<WorkflowsTestRepository> {
	const databases = createWorkflowsTestProvider();
	const migration = await databases.acquire(request('migration'));
	try {
		await migrateWorkflowsDatabase(migration.database);
	} finally {
		await migration.release();
	}
	const runtime = await databases.acquire(request('runtime'));
	const background = await databases.acquire(request('background'));
	const repository = new DatabaseWorkflowsRepository(
		{ runtime: runtime.database, background: background.database },
		options.payloadCodec ??
			createWorkflowPayloadCodec(Buffer.alloc(32, 'flowdular-workflows-test')),
		options.payloadRetentionMs,
	);
	return {
		repository,
		databases,
		async dispose() {
			await repository.close();
			await background.release();
			await runtime.release();
			await databases.dispose();
		},
	};
}

/**
 * A runtime that owns its embedded database. Disposing the runtime disposes
 * the provider, so a test that needs two runtimes over one database passes its
 * own provider to `createWorkflowsRuntime` instead.
 */
export function createWorkflowsTestRuntime(
	options: Omit<WorkflowsRuntimeOptions, 'databases'> = {},
): WorkflowsRuntime {
	const databases = createWorkflowsTestProvider();
	const runtime = createWorkflowsRuntime({ ...options, databases });
	return {
		service: () => runtime.service(),
		start: () => runtime.start(),
		stop: () => runtime.stop(),
		async dispose() {
			await runtime.dispose();
			await databases.dispose();
		},
	};
}

/** Borrows one handle for the length of a check the repository does not expose. */
export async function withHandle<T>(
	databases: DatabaseProvider,
	purpose: DatabaseProviderRequest['purpose'],
	body: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
	const lease = await databases.acquire(request(purpose));
	try {
		return await body(lease.database);
	} finally {
		await lease.release();
	}
}

/** Borrows the schema-owning handle, the one lease that is not tenant scoped. */
export function withOwnerHandle<T>(
	databases: DatabaseProvider,
	body: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
	return withHandle(databases, 'migration', body);
}

/** Runs a multi-statement script as the schema owner. */
export function executeScriptAsOwner(
	databases: DatabaseProvider,
	sql: string,
): Promise<void> {
	return withOwnerHandle(databases, async (database) => {
		await database.transaction(
			(transaction) => transaction.executeScript(sql),
			{
				access: 'write',
			},
		);
	});
}

/**
 * Runs one statement as the schema owner. A test uses it to stage worker state
 * no repository method has a reason to expose, such as a lease lost to a
 * crashed process.
 */
export function executeAsOwner(
	databases: DatabaseProvider,
	tenantId: string,
	text: string,
	parameters: readonly unknown[] = [],
): Promise<void> {
	return withOwnerHandle(databases, async (database) => {
		await database.transaction(
			(transaction) =>
				transaction.execute({ text, parameters: parameters as never }),
			{ access: 'write', tenantId },
		);
	});
}
