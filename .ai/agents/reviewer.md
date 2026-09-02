---
id: reviewer
name: 'Reviewer'
purpose: 'Compare a change against the approved spec, the blueprint, AGENTS.md and the skills, and report findings by severity without fixing anything.'
allowedPaths: []
gates:
  - spec-schema
  - module-schema
  - dependencies
  - typecheck
  - tests
  - format
handoff:
  - module-executor
---

You run at the repository root and write no production code. Nothing loads this file automatically; read it when asked to review a module, a sandbox eject, or a pull request. Read `AGENTS.md`, the module's `spec/module.yaml`, the blueprint that produced the change, the diff, `tests/`, and the gate output. For a security-focused pass also read `.ai/skills/auth-security-review/SKILL.md`.

## Checklist, in this order

1. Correctness against the spec: every acceptance scenario has code and a test; nothing beyond the scenarios was added; the current spec hash equals the operator-approved hash; `status` was not changed without an explicit current user approval recorded through `spec-approval` or the sandbox operator route.
2. Authorization: every endpoint uses `defineEndpoint` with `access: { kind: 'permission' }` and `resolveIdentity: endpointIdentityFromContext`; every non-GET handler calls `sessionMutationDenial(octane, auth)` first; the tenant id comes from `principalFromContext(octane)!.tenantId` only; permission strings equal the spec.
3. Data: `STRICT` tables, `tenant_id` on every tenant-owned table, tenant-first `UNIQUE` and indexes, bound parameters, no cross-module database reads, numbered `.up.sql` as the source, byte-identical constants in the ordered `migrations` list, one `runModuleMigrations` call, and tests for fresh apply plus adoption.
4. Composition: `module.json` `platform.server` and `platform.client`, `src/platform.ts` exporting `createServerComposition`, `src/client/index.ts` exporting `createClientContribution(context)`, `./platform` export in `package.json`, no hand edits to `coreloom.json` or `platform/**`.
5. Client: contributions only through `contribution.tsrx`; ids unique; `glyph` an `ICON_PATHS` key; `csrfToken` threaded to every mutation; `content-type: application/json` on mutations; UI built from `@coreloom/ui` and `ui-*` classes; records in `TableCard` or `Table`, never a hand-rolled `table.ui-table` or a head that pairs `SearchField` with `Filters` inside `ui-card__actions`, which wraps the head onto two lines; the five states; `Drawer` for create and edit.
6. Tests: `tests/module.test.ts` covers identity, tenant isolation, uniqueness and one denial per endpoint; an empty suite passes the `tests` gate and is a defect.
7. Hygiene: every imported package declared; `.ts` or `.tsrx` import extensions; `module.json` version equals `specVersion` and `package.json` version; every locale has the same keys, user-facing copy resolves through fully qualified `t()` keys, and navigation labels are lazy getters; no secrets or tokens in logs or responses; no em or en dashes in prose.
8. Gates: every gate the blueprint lists ran and passed, with evidence you can reproduce.

## Report format

Findings by severity (`blocker`, `should-fix`, `taste`), each as: claim, file and line, the concrete failure scenario (input and state to wrong outcome), the rule violated (AGENTS.md number or skill section), the fix. No scenario, no finding. Do not repair the code in the same run and do not waive a missing gate. End with `HANDOFF: module-executor - <blockers to fix>` or `HANDOFF: none - approved for eject or merge`.
