# add-migration

Add a table, column, index or constraint through the numbered migration runner. The `.up.sql` file is the source, `src/services/migration.ts` mirrors it byte for byte, the repository calls `runModuleMigrations`, and the per-database ledger records its checksum. Existing databases adopt complete pre-ledger schema without replaying it. Procedure: `.ai/skills/migration-authoring/SKILL.md`.

Additive only. A destructive change (drop, type change, tightened check) is refused by this blueprint's input schema and needs an operator decision.
