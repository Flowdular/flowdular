#!/bin/bash
# Runs once, during first cluster initialization. The migrator owns the schema;
# the runtime and background roles hold neither SUPERUSER nor BYPASSRLS, so the
# row-level security every tenant table forces actually binds the application.
# The background role exists for the cross-tenant scheduler poll only. It gets
# no blanket table grant here: each migration grants it the exact columns its
# poll reads, under a policy of that table's own.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv database_name POSTGRES_DB
\getenv migrator_password FD_DATABASE_MIGRATOR_PASSWORD
\getenv runtime_password FD_DATABASE_RUNTIME_PASSWORD
\getenv background_password FD_DATABASE_BACKGROUND_PASSWORD
CREATE ROLE flowdular_migrator LOGIN PASSWORD :'migrator_password'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE flowdular_runtime LOGIN PASSWORD :'runtime_password'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE flowdular_background LOGIN PASSWORD :'background_password'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

REVOKE CONNECT ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO flowdular_migrator, flowdular_runtime, flowdular_background;

ALTER SCHEMA public OWNER TO flowdular_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO flowdular_runtime, flowdular_background;

-- Every table the migrator creates later is reachable by the runtime role
-- without a second grant step after each migration.
ALTER DEFAULT PRIVILEGES FOR ROLE flowdular_migrator IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowdular_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE flowdular_migrator IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO flowdular_runtime;
SQL
