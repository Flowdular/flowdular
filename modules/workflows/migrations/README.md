# Migrations

Migrations in this directory are append-only after release.

`0002` stores the durable delegated user separately from the workflow audit
actor. Legacy user and service runs are backfilled, while legacy agent runs
without trustworthy delegation remain unset and therefore fail closed.
