import { randomBytes } from 'node:crypto';
import {
	assertDatabaseRequirements,
	assertNamespace,
	assertNotAborted,
	assertSchemaName,
	DatabaseError,
	operationSignal,
	PostgresDatabaseAdapter,
	type DatabaseAdapter,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
	type PostgresDriverPool,
} from '@flowdular/database';
import { Pool, type PoolConfig } from 'pg';

export interface PostgresTestProviderOptions {
	/** Owner role that creates the schema and runs migrations. */
	readonly migratorUrl: string;
	/** Runtime role. Defaults to the migrator role, which forced RLS still binds. */
	readonly runtimeUrl?: string | undefined;
	/** Cross-tenant read role. Defaults to the runtime role. */
	readonly backgroundUrl?: string | undefined;
	readonly schema?: string | undefined;
	readonly statementTimeoutMs?: number | undefined;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/* Roles reach this module from deployment configuration, never from a request,
   but they are still interpolated into DDL that takes no parameters. */
function quotedRole(role: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(role)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			`"${role}" is not a usable PostgreSQL role name for a test provider.`,
		);
	}
	return `"${role}"`;
}

function poolConfig(
	connectionString: string,
	schema: string,
	statementTimeoutMs: number,
): PoolConfig {
	return {
		connectionString,
		application_name: 'flowdular-test',
		max: 4,
		options: `-c search_path=${schema}`,
		statement_timeout: statementTimeoutMs,
		query_timeout: statementTimeoutMs * 2,
	};
}

function driverPool(pool: Pool): PostgresDriverPool {
	return {
		cancellation: 'before-start',
		async connect() {
			const client = await pool.connect();
			return {
				async query({ text, values }) {
					const result = await client.query({
						text,
						...(values === undefined ? {} : { values }),
					});
					return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
				},
				release: (error) => client.release(error),
			};
		},
		end: () => pool.end(),
	};
}

async function withPool<T>(
	connectionString: string,
	operation: (pool: Pool) => Promise<T>,
): Promise<T> {
	const pool = new Pool({ connectionString, max: 1 });
	try {
		return await operation(pool);
	} finally {
		await pool.end();
	}
}

/* An isolated schema per provider, so a suite that runs beside another one
   cannot see or drop its tables. The runtime role is granted through default
   privileges before any migration runs, because the migrator owns every table
   it later creates. */
export async function createPostgresTestProvider(
	options: PostgresTestProviderOptions,
): Promise<DatabaseProvider> {
	const schema =
		options.schema ?? `coreloom_test_${randomBytes(8).toString('hex')}`;
	assertSchemaName(schema);
	const runtimeUrl = options.runtimeUrl ?? options.migratorUrl;
	const statementTimeoutMs =
		options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

	const backgroundUrl = options.backgroundUrl ?? runtimeUrl;
	const roleOf = (url: string) =>
		withPool(url, async (pool) => {
			const result = await pool.query<{ current_user: string }>(
				'SELECT current_user',
			);
			return result.rows[0]!.current_user;
		});
	const runtimeRole = await roleOf(runtimeUrl);
	const backgroundRole = await roleOf(backgroundUrl);

	await withPool(options.migratorUrl, async (pool) => {
		const migratorRole = (
			await pool.query<{ current_user: string }>('SELECT current_user')
		).rows[0]!.current_user;
		await pool.query(`CREATE SCHEMA ${schema}`);
		for (const role of new Set([runtimeRole, backgroundRole])) {
			await pool.query(
				`GRANT USAGE ON SCHEMA ${schema} TO ${quotedRole(role)}`,
			);
		}
		await pool.query(
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedRole(migratorRole)} IN SCHEMA ${schema}
			 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole(runtimeRole)}`,
		);
		await pool.query(
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedRole(migratorRole)} IN SCHEMA ${schema}
			 GRANT USAGE, SELECT ON SEQUENCES TO ${quotedRole(runtimeRole)}`,
		);
	});

	const migrator = new PostgresDatabaseAdapter({
		pool: driverPool(
			new Pool(poolConfig(options.migratorUrl, schema, statementTimeoutMs)),
		),
	});
	const runtime = new PostgresDatabaseAdapter({
		pool: driverPool(
			new Pool(poolConfig(runtimeUrl, schema, statementTimeoutMs)),
		),
		tenantRequired: true,
	});
	const background = new PostgresDatabaseAdapter({
		pool: driverPool(
			new Pool(poolConfig(backgroundUrl, schema, statementTimeoutMs)),
		),
	});
	const adapters: readonly DatabaseAdapter[] = [migrator, runtime, background];
	let disposed = false;

	return {
		async acquire(
			request: DatabaseProviderRequest,
		): Promise<DatabaseAdapterLease> {
			if (disposed) {
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The PostgreSQL test provider is not accepting leases.',
				);
			}
			assertNamespace(request.namespace);
			assertNotAborted(operationSignal(request));
			const database =
				request.purpose === 'migration'
					? migrator
					: request.purpose === 'background'
						? background
						: runtime;
			assertDatabaseRequirements(database, request.requirements);
			return { database, release: () => Promise.resolve() };
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
			await withPool(options.migratorUrl, (pool) =>
				pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
			);
		},
	};
}
