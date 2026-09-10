import { randomBytes } from 'node:crypto';
import {
	assertDatabaseRequirements,
	assertNamespace,
	assertNotAborted,
	DatabaseError,
	operationSignal,
	PostgresDatabaseAdapter,
	type DatabaseAdapter,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';

const RUNTIME_ROLE = 'coreloom_runtime';
const BACKGROUND_ROLE = 'coreloom_background';

/* The roles exist before the first migration, so a table created later is
   reachable by the runtime role through default privileges. The background role
   gets no default table grant: a table it may poll across tenants says so in
   its own migration, by granting the named columns under a policy of its own. */
const BOOTSTRAP = `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
    CREATE ROLE ${RUNTIME_ROLE} NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BACKGROUND_ROLE}') THEN
    CREATE ROLE ${BACKGROUND_ROLE} NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}, ${BACKGROUND_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${RUNTIME_ROLE};
`;

export interface PgliteTestProviderOptions {
	/** Durable directory. Omit for an in-memory database. */
	readonly dataDirectory?: string | undefined;
}

/**
 * An embedded PostgreSQL a suite can own outright: real forced row-level
 * security, real roles, no server to start. Every purpose maps to the role a
 * deployment would use, so a test proves the same boundary production enforces.
 */
export function createPgliteTestProvider(
	options: PgliteTestProviderOptions = {},
): DatabaseProvider {
	const cluster = createPgliteCluster({
		dataDirectory: options.dataDirectory,
		bootstrap: BOOTSTRAP,
	});
	let adapters: {
		migrator: DatabaseAdapter;
		runtime: DatabaseAdapter;
		background: DatabaseAdapter;
	} | null = null;
	let disposed = false;

	const opened = () => {
		adapters ??= {
			migrator: new PostgresDatabaseAdapter({ pool: cluster.pool() }),
			runtime: new PostgresDatabaseAdapter({
				pool: cluster.pool(RUNTIME_ROLE),
				tenantRequired: true,
			}),
			background: new PostgresDatabaseAdapter({
				pool: cluster.pool(BACKGROUND_ROLE),
			}),
		};
		return adapters;
	};

	return {
		async acquire(
			request: DatabaseProviderRequest,
		): Promise<DatabaseAdapterLease> {
			if (disposed) {
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The PGlite test provider is not accepting leases.',
				);
			}
			assertNamespace(request.namespace);
			assertNotAborted(operationSignal(request));
			const open = opened();
			const database =
				request.purpose === 'migration'
					? open.migrator
					: request.purpose === 'background'
						? open.background
						: open.runtime;
			assertDatabaseRequirements(database, request.requirements);
			return {
				database,
				release: () => Promise.resolve(),
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const open = adapters;
			adapters = null;
			if (open) {
				await Promise.allSettled([
					open.background.dispose(),
					open.runtime.dispose(),
					open.migrator.dispose(),
				]);
				return;
			}
			await cluster.close();
		},
	};
}

/** A disposable name for a suite that wants an isolated durable directory. */
export function pgliteTestDirectory(prefix = 'flowdular-pglite'): string {
	return `${prefix}-${randomBytes(6).toString('hex')}`;
}
