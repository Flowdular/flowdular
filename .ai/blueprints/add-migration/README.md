# add-migration

Add a table, column, index or constraint to a module's SQLite schema the way the platform applies schema today: an idempotent constant in `src/services/migration.ts` run by the repository constructor, mirrored into `migrations/000N_<module>_<name>.{up,down}.sql`. There is no migration runner, ledger or checksum; `docs/architecture-blueprint.md` section 10 is not implemented. Procedure: `.ai/skills/migration-authoring/SKILL.md`.

Additive only. A destructive change (drop, type change, tightened check) is refused by this blueprint's input schema and needs an operator decision.
