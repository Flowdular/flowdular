import { AsyncLocalStorage } from 'node:async_hooks';
import {
	assertNamespace,
	assertNotAborted,
	assertSchemaName,
	assertStatement,
	assertTenantId,
	databaseDialectSql,
	DATABASE_ADAPTER_IDS,
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	DatabaseError,
	operationSignal,
	type DatabaseAdapter,
	type DatabaseAdapterState,
	type DatabaseCapabilities,
	type DatabaseCommandResult,
	type DatabaseOperationOptions,
	type DatabaseQueryResult,
	type DatabaseRow,
	type DatabaseSession,
	type DatabaseSchemaIntrospector,
	type DatabaseStatement,
	type DatabaseTransaction,
	type DatabaseTransactionOptions,
} from './contracts.ts';

export interface PostgresDriverResult {
	readonly rows?: readonly Record<string, unknown>[];
	readonly rowCount?: number | null;
}

export interface PostgresDriverQuery {
	readonly text: string;
	readonly values?: unknown[];
	readonly signal?: AbortSignal;
}

/** Minimal structural port implemented by a node-postgres PoolClient wrapper. */
export interface PostgresDriverClient {
	query(query: PostgresDriverQuery): Promise<PostgresDriverResult>;
	release(error?: Error): void;
}

/** The adapter owns the pool and ends it exactly once during disposal. */
export interface PostgresDriverPool {
	/** Declare `driver` only when query() actively cancels work on signal abort. */
	readonly cancellation?: 'before-start' | 'driver';
	connect(): Promise<PostgresDriverClient>;
	end(): Promise<void>;
}

export interface PostgresDatabaseAdapterOptions {
	readonly pool: PostgresDriverPool;
	/** Runtime handles require transaction-scoped tenant context for every query. */
	readonly tenantRequired?: boolean;
}

const CAPABILITIES: DatabaseCapabilities = Object.freeze({
	features: Object.freeze([
		DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
		DATABASE_CAPABILITY_IDS.RETURNING,
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	]),
	parameterStyle: 'numbered',
	migrationLock: 'advisory-transaction',
	transactionalDdl: true,
	returning: true,
	isolationLevels: [
		'read-committed',
		'repeatable-read',
		'serializable',
	] as const,
	cancellation: 'before-start',
	schemaIntrospection: true,
	tenantIsolation: 'transaction-local-rls',
	rootOperations: 'allowed',
	sql: databaseDialectSql(DATABASE_DIALECT_IDS.postgresql),
});

function values(statement: DatabaseStatement): unknown[] | undefined {
	return statement.parameters ? [...statement.parameters] : undefined;
}

function combinedSignal(
	base: AbortSignal | undefined,
	options: DatabaseOperationOptions,
): AbortSignal | undefined {
	const current = operationSignal(options);
	return base && current ? AbortSignal.any([base, current]) : (base ?? current);
}

function driverQuery(
	text: string,
	values: unknown[] | undefined,
	signal: AbortSignal | undefined,
): PostgresDriverQuery {
	return {
		text,
		...(values === undefined ? {} : { values }),
		...(signal === undefined ? {} : { signal }),
	};
}

class PostgresSchemaIntrospector implements DatabaseSchemaIntrospector {
	constructor(
		private readonly client: PostgresDriverClient,
		private readonly baseSignal?: AbortSignal,
		private readonly ensureActive: () => void = () => {},
	) {}

	async hasTable(
		name: string,
		options: DatabaseOperationOptions = {},
	): Promise<boolean> {
		this.ensureActive();
		assertSchemaName(name);
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		const result = await this.client.query(
			driverQuery(
				`SELECT 1 AS present FROM information_schema.tables
				 WHERE table_schema = current_schema() AND table_name = $1`,
				[name],
				signal,
			),
		);
		return (result.rowCount ?? result.rows?.length ?? 0) > 0;
	}

	async hasColumn(
		table: string,
		column: string,
		options: DatabaseOperationOptions = {},
	): Promise<boolean> {
		this.ensureActive();
		assertSchemaName(table);
		assertSchemaName(column);
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		const result = await this.client.query(
			driverQuery(
				`SELECT 1 AS present FROM information_schema.columns
				 WHERE table_schema = current_schema() AND table_name = $1
				 AND column_name = $2`,
				[table, column],
				signal,
			),
		);
		return (result.rowCount ?? result.rows?.length ?? 0) > 0;
	}

	async hasIndex(
		name: string,
		options: DatabaseOperationOptions = {},
	): Promise<boolean> {
		this.ensureActive();
		assertSchemaName(name);
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		const result = await this.client.query(
			driverQuery(
				`SELECT 1 AS present FROM pg_indexes
				 WHERE schemaname = current_schema() AND indexname = $1`,
				[name],
				signal,
			),
		);
		return (result.rowCount ?? result.rows?.length ?? 0) > 0;
	}
}

class PostgresSession implements DatabaseSession {
	readonly adapterId = DATABASE_ADAPTER_IDS.postgresql;
	readonly dialectId = DATABASE_DIALECT_IDS.postgresql;
	readonly schema: DatabaseSchemaIntrospector;

	constructor(
		protected readonly client: PostgresDriverClient,
		protected readonly baseSignal?: AbortSignal,
		protected readonly ensureActive: () => void = () => {},
		readonly capabilities: DatabaseCapabilities = CAPABILITIES,
	) {
		this.schema = new PostgresSchemaIntrospector(
			client,
			baseSignal,
			ensureActive,
		);
	}

	async query<Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options: DatabaseOperationOptions = {},
	): Promise<DatabaseQueryResult<Row>> {
		this.ensureActive();
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		assertStatement(statement);
		const result = await this.client.query(
			driverQuery(statement.text, values(statement), signal),
		);
		const rows = (result.rows ?? []) as readonly Row[];
		return { rows, rowCount: result.rowCount ?? rows.length };
	}

	async execute(
		statement: DatabaseStatement,
		options: DatabaseOperationOptions = {},
	): Promise<DatabaseCommandResult> {
		this.ensureActive();
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		assertStatement(statement);
		const result = await this.client.query(
			driverQuery(statement.text, values(statement), signal),
		);
		return { affectedRows: result.rowCount ?? 0 };
	}

	async executeScript(
		script: string,
		options: DatabaseOperationOptions = {},
	): Promise<void> {
		this.ensureActive();
		const signal = combinedSignal(this.baseSignal, options);
		assertNotAborted(signal);
		if (script.trim().length === 0) {
			throw new DatabaseError(
				'INVALID_ARGUMENT',
				'Migration SQL cannot be empty.',
			);
		}
		await this.client.query(driverQuery(script, undefined, signal));
	}
}

class PostgresTransaction
	extends PostgresSession
	implements DatabaseTransaction
{
	async acquireMigrationLock(namespace: string): Promise<void> {
		this.ensureActive();
		assertNamespace(namespace);
		await this.client.query(
			driverQuery(
				'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
				['coreloom-migration', namespace],
				this.baseSignal,
			),
		);
	}
}

function beginStatement(options: DatabaseTransactionOptions): string {
	const isolation = (options.isolation ?? 'read-committed')
		.split('-')
		.map((part) => part.toUpperCase())
		.join(' ');
	const access = options.access === 'read' ? 'READ ONLY' : 'READ WRITE';
	return `BEGIN ISOLATION LEVEL ${isolation} ${access}`;
}

export class PostgresDatabaseAdapter implements DatabaseAdapter {
	readonly adapterId = DATABASE_ADAPTER_IDS.postgresql;
	readonly dialectId = DATABASE_DIALECT_IDS.postgresql;
	readonly capabilities: DatabaseCapabilities;
	readonly schema: DatabaseSchemaIntrospector = {
		hasTable: (name, options) =>
			this.#schemaOperation((schema) => schema.hasTable(name), options),
		hasColumn: (table, column, options) =>
			this.#schemaOperation(
				(schema) => schema.hasColumn(table, column),
				options,
			),
		hasIndex: (name, options) =>
			this.#schemaOperation((schema) => schema.hasIndex(name), options),
	};
	readonly #pool: PostgresDriverPool;
	readonly #tenantRequired: boolean;
	readonly #active = new Set<Promise<unknown>>();
	readonly #transactionContext = new AsyncLocalStorage<boolean>();
	#state: DatabaseAdapterState = 'ready';
	#disposePromise: Promise<void> | undefined;

	constructor(options: PostgresDatabaseAdapterOptions) {
		this.#pool = options.pool;
		this.#tenantRequired = options.tenantRequired ?? false;
		this.capabilities = Object.freeze({
			...CAPABILITIES,
			cancellation: options.pool.cancellation ?? 'before-start',
			rootOperations: this.#tenantRequired
				? 'tenant-transaction-only'
				: 'allowed',
		});
	}

	get state(): DatabaseAdapterState {
		return this.#state;
	}

	async query<Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options: DatabaseOperationOptions = {},
	): Promise<DatabaseQueryResult<Row>> {
		this.#assertRootUse();
		this.#assertRootOperation();
		const signal = operationSignal(options);
		return this.#track(async () => {
			const client = await this.#pool.connect();
			try {
				return await new PostgresSession(
					client,
					signal,
					undefined,
					this.capabilities,
				).query<Row>(statement);
			} finally {
				client.release();
			}
		});
	}

	async execute(
		statement: DatabaseStatement,
		options: DatabaseOperationOptions = {},
	): Promise<DatabaseCommandResult> {
		this.#assertRootUse();
		this.#assertRootOperation();
		const signal = operationSignal(options);
		return this.#track(async () => {
			const client = await this.#pool.connect();
			try {
				return await new PostgresSession(
					client,
					signal,
					undefined,
					this.capabilities,
				).execute(statement);
			} finally {
				client.release();
			}
		});
	}

	async executeScript(
		script: string,
		options: DatabaseOperationOptions = {},
	): Promise<void> {
		this.#assertRootUse();
		this.#assertRootOperation();
		const signal = operationSignal(options);
		return this.#track(async () => {
			const client = await this.#pool.connect();
			try {
				await new PostgresSession(
					client,
					signal,
					undefined,
					this.capabilities,
				).executeScript(script);
			} finally {
				client.release();
			}
		});
	}

	async transaction<T>(
		operation: (transaction: DatabaseTransaction) => Promise<T>,
		options: DatabaseTransactionOptions = {},
	): Promise<T> {
		this.#assertRootUse();
		if (this.#tenantRequired && options.tenantId === undefined) {
			throw new DatabaseError(
				'TENANT_CONTEXT_REQUIRED',
				'PostgreSQL runtime operations require a transaction tenant id.',
			);
		}
		if (options.tenantId !== undefined) assertTenantId(options.tenantId);
		const signal = operationSignal(options);
		return this.#track(async () => {
			assertNotAborted(signal);
			const client = await this.#pool.connect();
			let releaseError: Error | undefined;
			let began = false;
			const lease = { active: true };
			const ensureActive = () => {
				if (!lease.active) {
					throw new DatabaseError(
						'TRANSACTION_CONTEXT_MISUSE',
						'The PostgreSQL transaction callback has already ended.',
					);
				}
			};
			try {
				try {
					await client.query(
						driverQuery(beginStatement(options), undefined, signal),
					);
					began = true;
					if (options.tenantId !== undefined) {
						await client.query(
							driverQuery(
								"SELECT set_config('coreloom.tenant_id', $1, true)",
								[options.tenantId],
								signal,
							),
						);
					}
					assertNotAborted(signal);
					const result = await this.#transactionContext.run(true, () =>
						operation(
							new PostgresTransaction(
								client,
								signal,
								ensureActive,
								this.capabilities,
							),
						),
					);
					lease.active = false;
					assertNotAborted(signal);
					await client.query(driverQuery('COMMIT', undefined, signal));
					return result;
				} catch (error) {
					lease.active = false;
					if (began) {
						try {
							await client.query(driverQuery('ROLLBACK', undefined, undefined));
						} catch (rollbackError) {
							releaseError =
								rollbackError instanceof Error
									? rollbackError
									: new Error(String(rollbackError));
						}
					} else {
						releaseError =
							error instanceof Error ? error : new Error(String(error));
					}
					throw error;
				}
			} finally {
				client.release(releaseError);
			}
		});
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#state = 'disposing';
		this.#disposePromise = (async () => {
			await Promise.allSettled([...this.#active]);
			await this.#pool.end();
			this.#state = 'disposed';
		})();
		return this.#disposePromise;
	}

	#track<T>(operation: () => Promise<T>): Promise<T> {
		const promise = operation();
		this.#active.add(promise);
		void promise.then(
			() => this.#active.delete(promise),
			() => this.#active.delete(promise),
		);
		return promise;
	}

	#assertRootUse(): void {
		if (this.#state !== 'ready') {
			throw new DatabaseError(
				'ADAPTER_DISPOSED',
				'The PostgreSQL database adapter is not accepting work.',
			);
		}
		if (this.#transactionContext.getStore()) {
			throw new DatabaseError(
				'TRANSACTION_CONTEXT_MISUSE',
				'Use the transaction argument inside a transaction callback.',
			);
		}
	}

	#assertRootOperation(): void {
		if (!this.#tenantRequired) return;
		throw new DatabaseError(
			'TENANT_CONTEXT_REQUIRED',
			'Use a transaction with tenantId for PostgreSQL runtime operations.',
		);
	}

	async #schemaOperation(
		operation: (schema: DatabaseSchemaIntrospector) => Promise<boolean>,
		options: DatabaseOperationOptions = {},
	): Promise<boolean> {
		this.#assertRootUse();
		this.#assertRootOperation();
		const signal = operationSignal(options);
		return this.#track(async () => {
			const client = await this.#pool.connect();
			try {
				return await operation(new PostgresSchemaIntrospector(client, signal));
			} finally {
				client.release();
			}
		});
	}
}

export function createPostgresDatabaseAdapter(
	options: PostgresDatabaseAdapterOptions,
): DatabaseAdapter {
	return new PostgresDatabaseAdapter(options);
}
