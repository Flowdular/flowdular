#!/bin/bash
# Runs once, during first cluster initialization. The migrator owns the schema;
# the runtime and background roles hold neither SUPERUSER nor BYPASSRLS, so the
# row-level security every tenant table forces actually binds the application.
# The background role exists for the cross-tenant scheduler poll only. It gets
# no blanket table grant here: each migration grants it the exact columns its
# poll reads, under a policy of that table's own.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE coreloom_migrator LOGIN PASSWORD '${FD_DATABASE_MIGRATOR_PASSWORD}'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE coreloom_runtime LOGIN PASSWORD '${FD_DATABASE_RUNTIME_PASSWORD}'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE coreloom_background LOGIN PASSWORD '${FD_DATABASE_BACKGROUND_PASSWORD}'
	NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

REVOKE CONNECT ON DATABASE "$POSTGRES_DB" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO coreloom_migrator, coreloom_runtime, coreloom_background;

ALTER SCHEMA public OWNER TO coreloom_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO coreloom_runtime, coreloom_background;

-- Every table the migrator creates later is reachable by the runtime role
-- without a second grant step after each migration.
ALTER DEFAULT PRIVILEGES FOR ROLE coreloom_migrator IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coreloom_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE coreloom_migrator IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO coreloom_runtime;
SQL
