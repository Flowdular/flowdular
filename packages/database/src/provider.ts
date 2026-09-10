import {
	flowdularEnvironment,
	flowdularStateDirectory,
} from '@flowdular/kernel/runtime-config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	PostgresDatabaseAdapter,
	type PostgresDriverPool,
} from './postgresql.ts';
import {
	assertDatabaseRequirements,
	assertNamespace,
	assertNotAborted,
	DatabaseError,
	operationSignal,
	type DatabaseAdapter,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from './contracts.ts';

export type ConfiguredDatabaseAdapter = 'pglite' | 'postgresql';

export interface DatabaseProviderConfig {
	readonly adapter: ConfiguredDatabaseAdapter;
	readonly production: boolean;
	readonly workspaceRoot: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly postgresql?: {
		readonly runtime: Readonly<DatabasePoolConfig>;
		readonly migrator: Readonly<DatabasePoolConfig>;
		/* Absent when a deployment declares no cross-tenant background role; a
		   background lease is then refused instead of silently widened. */
		readonly background?: Readonly<DatabasePoolConfig> | undefined;
		readonly queryTimeoutMs: number;
	};
	readonly pglite?: {
		/** Absent keeps the database in memory, which is what a suite wants. */
		readonly dataDirectory: string | undefined;
	};
}

export interface DatabaseReadiness {
	readonly adapter: ConfiguredDatabaseAdapter;
	readonly status: 'ready';
}

export interface ConfiguredDatabaseProvider extends DatabaseProvider {
	readonly adapter: ConfiguredDatabaseAdapter;
	/** Bounded readiness check used before activation and by /api/ready. */
	check(): Promise<DatabaseReadiness>;
}

/** The subset of a node-postgres pool configuration this provider sets. */
export interface DatabasePoolConfig {
	readonly connectionString?: string;
	readonly ssl?:
		| boolean
		| { readonly rejectUnauthorized: boolean; readonly ca?: string }
		| undefined;
	readonly application_name?: string;
	readonly max?: number;
	readonly min?: number;
	readonly connectionTimeoutMillis?: number;
	readonly idleTimeoutMillis?: number;
	readonly query_timeout?: number;
	readonly statement_timeout?: number;
	readonly lock_timeout?: number;
}

export interface DatabasePostgresPoolClient {
	query(query: {
		readonly text: string;
		readonly values?: unknown[];
	}): Promise<{
		readonly rows?: readonly Record<string, unknown>[];
		readonly rowCount?: number | null;
	}>;
	release(error?: Error): void;
}

export interface DatabasePostgresPool {
	connect(): Promise<DatabasePostgresPoolClient>;
	end(): Promise<void>;
}

export interface DatabaseProviderFactories {
	/** Required for the PostgreSQL adapter. The package owns no driver. */
	readonly postgresPool?: (config: DatabasePoolConfig) => DatabasePostgresPool;
	/**
	 * Required for the embedded PostgreSQL adapter. The contract package owns no
	 * driver, so the caller supplies one cluster and the provider takes a pool
	 * per role from it, exactly as a deployment separates them by connection.
	 */
	readonly pgliteCluster?: (options: {
		readonly dataDirectory: string | undefined;
		readonly bootstrap: string;
	}) => {
		pool(role?: string): DatabasePostgresPool;
		close(): Promise<void>;
	};
}

type ProviderState = 'ready' | 'disposing' | 'disposed';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 20_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_POOL_MAX = 10;
const DEFAULT_POOL_MIN = 0;
const PGLITE_RUNTIME_ROLE = 'coreloom_runtime';
const PGLITE_BACKGROUND_ROLE = 'coreloom_background';
/* Created once, before the first lease, so every migration the migrator runs
   grants the runtime role by default privilege instead of a later step. */
const PGLITE_BOOTSTRAP = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PGLITE_RUNTIME_ROLE}') THEN
    CREATE ROLE ${PGLITE_RUNTIME_ROLE} NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PGLITE_BACKGROUND_ROLE}') THEN
    CREATE ROLE ${PGLITE_BACKGROUND_ROLE} NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO ${PGLITE_RUNTIME_ROLE}, ${PGLITE_BACKGROUND_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PGLITE_RUNTIME_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${PGLITE_RUNTIME_ROLE};
/* The background role gets no default table grant. A table it may poll across
   tenants says so itself, in its own migration, by granting the named columns
   under a FOR SELECT policy. Anything that forgets to is invisible to it. */
`;

function integerEnvironment(
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || value.trim().length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return parsed;
}

function adapterEnvironment(
	environment: NodeJS.ProcessEnv,
	production: boolean,
): ConfiguredDatabaseAdapter {
	const configured = environment.FD_DATABASE_ADAPTER?.trim();
	if (configured === undefined || configured.length === 0) {
		/* Outside production the platform ships its own PostgreSQL, so a
		   workstation needs no server and no configuration to start. */
		return production ? 'postgresql' : 'pglite';
	}
	if (configured !== 'pglite' && configured !== 'postgresql') {
		throw new Error('FD_DATABASE_ADAPTER must be "pglite" or "postgresql".');
	}
	/* An embedded PostgreSQL is a development and test convenience. A deployment
	   states its real database instead of shipping one inside the process. */
	if (configured === 'pglite' && production) {
		throw new Error('FD_DATABASE_ADAPTER=pglite is not a production adapter.');
	}
	return configured;
}

function postgresConnectionString(
	value: string | undefined,
	name:
		| 'FD_DATABASE_BACKGROUND_URL'
		| 'FD_DATABASE_MIGRATOR_URL'
		| 'FD_DATABASE_URL',
): string {
	value = value?.trim();
	if (!value) {
		throw new Error(`${name} is required for the PostgreSQL adapter.`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid PostgreSQL URL.`);
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new Error(`${name} must use postgres:// or postgresql://.`);
	}
	if (!url.hostname || !url.username || url.pathname.length < 2) {
		throw new Error(`${name} must include a host, user, and database name.`);
	}
	for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
		if (url.searchParams.has(parameter)) {
			throw new Error(
				`${name} cannot set ${parameter}; use the FD_DATABASE_TLS settings.`,
			);
		}
	}
	return value;
}

function postgresTls(
	environment: NodeJS.ProcessEnv,
	production: boolean,
): DatabasePoolConfig['ssl'] {
	const mode = environment.FD_DATABASE_TLS?.trim() || 'verify-full';
	if (mode !== 'disable' && mode !== 'require' && mode !== 'verify-full') {
		throw new Error(
			'FD_DATABASE_TLS must be "verify-full", "require", or "disable".',
		);
	}
	if (production && mode !== 'verify-full') {
		throw new Error(
			'Production PostgreSQL requires FD_DATABASE_TLS=verify-full.',
		);
	}
	if (mode === 'disable') return false;
	const ca = postgresTlsAuthority(environment);
	return {
		rejectUnauthorized: mode === 'verify-full',
		...(ca ? { ca } : {}),
	};
}

/* An orchestrator mounts a certificate authority as a file, while a shell
   deployment usually exports it inline. Accepting both keeps the PEM out of
   process listings and out of a compose file that would have to inline it. */
function postgresTlsAuthority(
	environment: NodeJS.ProcessEnv,
): string | undefined {
	const inline = environment.FD_DATABASE_TLS_CA?.replaceAll('\\n', '\n').trim();
	const path = environment.FD_DATABASE_TLS_CA_FILE?.trim();
	if (inline && path) {
		throw new Error(
			'Set either FD_DATABASE_TLS_CA or FD_DATABASE_TLS_CA_FILE, not both.',
		);
	}
	if (!path) return inline || undefined;
	let contents: string;
	try {
		contents = readFileSync(path, 'utf8');
	} catch (error) {
		throw new Error(
			`FD_DATABASE_TLS_CA_FILE could not be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!contents.includes('BEGIN CERTIFICATE')) {
		throw new Error(
			'FD_DATABASE_TLS_CA_FILE must contain a PEM encoded certificate.',
		);
	}
	return contents;
}

export function databaseProviderConfigFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): DatabaseProviderConfig {
	environment = flowdularEnvironment(environment);
	const production = environment.NODE_ENV === 'production';
	const adapter = adapterEnvironment(environment, production);
	if (adapter === 'pglite') {
		const configured = environment.FD_DATABASE_PGLITE_DIRECTORY?.trim();
		return {
			adapter,
			production,
			workspaceRoot,
			environment,
			pglite: {
				dataDirectory:
					environment.NODE_ENV === 'test'
						? undefined
						: (configured ??
							resolve(
								flowdularStateDirectory(workspaceRoot),
								'data',
								'pglite',
							)),
			},
		};
	}
	const max = integerEnvironment(
		environment.FD_DATABASE_POOL_MAX,
		DEFAULT_POOL_MAX,
		'FD_DATABASE_POOL_MAX',
		1,
		100,
	);
	const min = integerEnvironment(
		environment.FD_DATABASE_POOL_MIN,
		DEFAULT_POOL_MIN,
		'FD_DATABASE_POOL_MIN',
		0,
		100,
	);
	if (min > max) {
		throw new Error('FD_DATABASE_POOL_MIN cannot exceed FD_DATABASE_POOL_MAX.');
	}
	const statementTimeout = integerEnvironment(
		environment.FD_DATABASE_STATEMENT_TIMEOUT_MS,
		DEFAULT_STATEMENT_TIMEOUT_MS,
		'FD_DATABASE_STATEMENT_TIMEOUT_MS',
		100,
		300_000,
	);
	const queryTimeout = integerEnvironment(
		environment.FD_DATABASE_QUERY_TIMEOUT_MS,
		DEFAULT_QUERY_TIMEOUT_MS,
		'FD_DATABASE_QUERY_TIMEOUT_MS',
		100,
		300_000,
	);
	const lockTimeout = integerEnvironment(
		environment.FD_DATABASE_LOCK_TIMEOUT_MS,
		DEFAULT_LOCK_TIMEOUT_MS,
		'FD_DATABASE_LOCK_TIMEOUT_MS',
		100,
		300_000,
	);
	if (queryTimeout < statementTimeout) {
		throw new Error(
			'FD_DATABASE_QUERY_TIMEOUT_MS cannot be shorter than FD_DATABASE_STATEMENT_TIMEOUT_MS.',
		);
	}
	if (lockTimeout > statementTimeout) {
		throw new Error(
			'FD_DATABASE_LOCK_TIMEOUT_MS cannot exceed FD_DATABASE_STATEMENT_TIMEOUT_MS.',
		);
	}
	const runtimeUrl = postgresConnectionString(
		environment.FD_DATABASE_URL,
		'FD_DATABASE_URL',
	);
	const migratorUrl = environment.FD_DATABASE_MIGRATOR_URL?.trim()
		? postgresConnectionString(
				environment.FD_DATABASE_MIGRATOR_URL,
				'FD_DATABASE_MIGRATOR_URL',
			)
		: production
			? (() => {
					throw new Error(
						'FD_DATABASE_MIGRATOR_URL is required for production PostgreSQL.',
					);
				})()
			: runtimeUrl;
	if (production && migratorUrl === runtimeUrl) {
		throw new Error(
			'Production PostgreSQL requires separate runtime and migrator credentials.',
		);
	}
	const backgroundUrl = environment.FD_DATABASE_BACKGROUND_URL?.trim()
		? postgresConnectionString(
				environment.FD_DATABASE_BACKGROUND_URL,
				'FD_DATABASE_BACKGROUND_URL',
			)
		: undefined;
	const common: DatabasePoolConfig = {
		ssl: postgresTls(environment, production),
		application_name: 'flowdular',
		max,
		min,
		connectionTimeoutMillis: integerEnvironment(
			environment.FD_DATABASE_CONNECT_TIMEOUT_MS,
			DEFAULT_CONNECT_TIMEOUT_MS,
			'FD_DATABASE_CONNECT_TIMEOUT_MS',
			100,
			120_000,
		),
		idleTimeoutMillis: integerEnvironment(
			environment.FD_DATABASE_IDLE_TIMEOUT_MS,
			DEFAULT_IDLE_TIMEOUT_MS,
			'FD_DATABASE_IDLE_TIMEOUT_MS',
			100,
			600_000,
		),
		query_timeout: queryTimeout,
		statement_timeout: statementTimeout,
		lock_timeout: lockTimeout,
	};
	return {
		adapter,
		production,
		workspaceRoot,
		environment,
		postgresql: {
			runtime: { ...common, connectionString: runtimeUrl },
			migrator: { ...common, connectionString: migratorUrl },
			...(backgroundUrl
				? { background: { ...common, connectionString: backgroundUrl } }
				: {}),
			queryTimeoutMs: queryTimeout,
		},
	};
}

function postgresDriverPool(pool: DatabasePostgresPool): PostgresDriverPool {
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

async function checkPostgresRole(
	database: DatabaseAdapter,
	role: 'runtime' | 'background',
	timeoutMs: number,
): Promise<void> {
	const result = await database.transaction(
		(transaction) =>
			transaction.query<{ rolsuper: boolean; rolbypassrls: boolean }>({
				text: `SELECT rolsuper, rolbypassrls
			       FROM pg_roles WHERE rolname = current_user`,
			}),
		{
			access: 'read',
			...(role === 'runtime' ? { tenantId: 'flowdular-readiness' } : {}),
			timeoutMs,
		},
	);
	const current = result.rows[0];
	if (!current || current.rolsuper || current.rolbypassrls) {
		throw new Error(
			`The PostgreSQL ${role} role must not be superuser or BYPASSRLS.`,
		);
	}
}

export function createDatabaseProvider(
	config: DatabaseProviderConfig,
	factories: DatabaseProviderFactories = {},
): ConfiguredDatabaseProvider {
	let state: ProviderState = 'ready';
	let leases = 0;
	let resolveDrained: (() => void) | undefined;
	let disposePromise: Promise<void> | undefined;
	const adapters = new Map<string, DatabaseAdapter>();
	if (config.adapter === 'postgresql' && !factories.postgresPool) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'The PostgreSQL adapter needs a postgresPool factory; @flowdular/database owns no driver.',
		);
	}
	const postgresRuntime =
		config.adapter === 'postgresql'
			? new PostgresDatabaseAdapter({
					pool: postgresDriverPool(
						factories.postgresPool!(config.postgresql!.runtime),
					),
					tenantRequired: true,
				})
			: undefined;
	const postgresMigrator =
		config.adapter === 'postgresql'
			? new PostgresDatabaseAdapter({
					pool: postgresDriverPool(
						factories.postgresPool!(config.postgresql!.migrator),
					),
				})
			: undefined;
	const postgresBackground =
		config.adapter === 'postgresql' && config.postgresql?.background
			? new PostgresDatabaseAdapter({
					pool: postgresDriverPool(
						factories.postgresPool!(config.postgresql.background),
					),
				})
			: undefined;
	if (postgresRuntime) adapters.set('postgresql-runtime', postgresRuntime);
	if (postgresMigrator) adapters.set('postgresql-migrator', postgresMigrator);
	if (postgresBackground) {
		adapters.set('postgresql-background', postgresBackground);
	}

	/* One embedded database, two roles. The migrator owns the schema, the runtime
	   role holds no BYPASSRLS, so a local run enforces the tenant isolation a
	   deployment enforces instead of approximating it. */
	if (config.adapter === 'pglite' && !factories.pgliteCluster) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'The embedded PostgreSQL adapter needs a pgliteCluster factory; @flowdular/database owns no driver.',
		);
	}
	const pgliteCluster =
		config.adapter === 'pglite'
			? factories.pgliteCluster!({
					dataDirectory: config.pglite?.dataDirectory,
					bootstrap: PGLITE_BOOTSTRAP,
				})
			: undefined;
	const pgliteMigrator = pgliteCluster
		? new PostgresDatabaseAdapter({
				pool: postgresDriverPool(pgliteCluster.pool()),
			})
		: undefined;
	const pgliteRuntime = pgliteCluster
		? new PostgresDatabaseAdapter({
				pool: postgresDriverPool(pgliteCluster.pool(PGLITE_RUNTIME_ROLE)),
				tenantRequired: true,
			})
		: undefined;
	/* Cross-tenant reads are not tenant scoped by definition, so this handle
	   carries no tenant context and the database decides what it may see. */
	const pgliteBackground = pgliteCluster
		? new PostgresDatabaseAdapter({
				pool: postgresDriverPool(pgliteCluster.pool(PGLITE_BACKGROUND_ROLE)),
			})
		: undefined;
	if (pgliteMigrator) adapters.set('pglite-migrator', pgliteMigrator);
	if (pgliteRuntime) adapters.set('pglite-runtime', pgliteRuntime);
	if (pgliteBackground) adapters.set('pglite-background', pgliteBackground);

	const databaseFor = (request: DatabaseProviderRequest): DatabaseAdapter => {
		if (pgliteRuntime && pgliteMigrator && pgliteBackground) {
			if (request.purpose === 'migration') return pgliteMigrator;
			return request.purpose === 'background'
				? pgliteBackground
				: pgliteRuntime;
		}
		if (postgresRuntime && postgresMigrator) {
			if (request.purpose === 'migration') return postgresMigrator;
			if (request.purpose !== 'background') return postgresRuntime;
			if (!postgresBackground) {
				throw new DatabaseError(
					'UNSUPPORTED_CAPABILITY',
					'A background lease needs FD_DATABASE_BACKGROUND_URL; this deployment declares no cross-tenant role.',
				);
			}
			return postgresBackground;
		}
		throw new DatabaseError(
			'UNSUPPORTED_CAPABILITY',
			`"${config.adapter}" is not a database adapter this platform provides.`,
		);
	};

	const provider: ConfiguredDatabaseProvider = {
		adapter: config.adapter,
		async acquire(request): Promise<DatabaseAdapterLease> {
			if (state !== 'ready') {
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The platform database provider is not accepting leases.',
				);
			}
			assertNamespace(request.namespace);
			const signal = operationSignal(request);
			assertNotAborted(signal);
			const database = databaseFor(request);
			assertDatabaseRequirements(database, request.requirements);
			leases += 1;
			let released = false;
			return {
				database,
				async release() {
					if (released) return;
					released = true;
					leases -= 1;
					if (leases === 0) resolveDrained?.();
				},
			};
		},
		async check() {
			if (state !== 'ready') {
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The platform database provider is not ready.',
				);
			}
			if (postgresRuntime && postgresMigrator) {
				const timeoutMs =
					config.postgresql?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
				await checkPostgresRole(postgresRuntime, 'runtime', timeoutMs);
				if (postgresBackground) {
					await checkPostgresRole(postgresBackground, 'background', timeoutMs);
				}
				await postgresMigrator.query(
					{ text: 'SELECT 1 AS coreloom_database_ready' },
					{
						timeoutMs:
							config.postgresql?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
					},
				);
			}
			return { adapter: config.adapter, status: 'ready' };
		},
		dispose() {
			if (disposePromise) return disposePromise;
			state = 'disposing';
			disposePromise = (async () => {
				if (leases > 0) {
					await new Promise<void>((resolveDrain) => {
						resolveDrained = resolveDrain;
					});
				}
				const results = await Promise.allSettled(
					[...adapters.values()].map((adapter) => adapter.dispose()),
				);
				state = 'disposed';
				const failures = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				);
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						'Platform database provider could not close every adapter.',
					);
				}
			})();
			return disposePromise;
		},
	};
	return provider;
}
