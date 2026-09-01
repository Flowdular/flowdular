# core-extend

Change a platform package (`packages/**`, `platform/**`, the schemas in `packages/contracts`, or the auth server contract in `modules/auth/src/server/composition.ts`). This runs at the repository root only; a sandbox session cannot reach these paths and hands off with the exact change needed. Procedure and checklists: `.ai/skills/core-extend/SKILL.md`.

Every public surface change names and migrates its consumers in the same change (modules, scaffold, generated composition, reference copies for sandbox sessions, docs, skills). Gates are the repository gates: `pnpm verify` and `pnpm build`. A change to a public boundary gets an ADR in `docs/adr`.
