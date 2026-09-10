import { join } from 'node:path';
import {
	assertNamespace,
	DatabaseError,
	PostgresDatabaseAdapter,
	type DatabaseAdapter,
	type DatabaseAdapterLease,
	type DatabaseProvider,
	type DatabaseProviderRequest,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';

const RUNTIME_ROLE = 'coreloom_runtime';
const BACKGROUND_ROLE = 'coreloom_background';

/* Created before the first lease, so every table the migration lease creates is
   reachable by the runtime role without a second grant step. */
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
`;

/* A preview owns its database the way it owns its authentication runtime: one
   embedded PostgreSQL under the session data directory, the only place the
   preview worker may write, thrown away with the session. A draft therefore
   meets the same forced row-level security a deployment enforces, and it is
   never handed a deployment adapter or a DSN. */
export function createPreviewDatabaseProvider(
	dataPath: string,
): DatabaseProvider {
	const cluster = createPgliteCluster({
		dataDirectory: join(dataPath, 'preview-postgres'),
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
			/* A draft that polls across tenants meets the same narrow role a
			   deployment gives it: no default table grant, so it reads only the
			   columns a migration named under that table's own policy. */
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
					'The preview database provider is not accepting leases.',
				);
			}
			assertNamespace(request.namespace);
			const { migrator, runtime, background } = opened();
			/* Releasing a lease closes nothing: a draft that leaks one must not be
			   able to keep the preview generation from retiring. */
			return {
				database:
					request.purpose === 'migration'
						? migrator
						: request.purpose === 'background'
							? background
							: runtime,
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
