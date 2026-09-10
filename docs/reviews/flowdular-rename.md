# Flowdular rename review

Reviewed 2026-09-10 against the working-copy snapshot taken before this task,
not against HEAD: this checkout already contained substantial unfinished work.
Concurrent sandbox review-routing edits were preserved and excluded from the
rename assessment.

## Scope and evidence

- Correctness: package manifests, imports, CLI binaries and aliases, creator
  templates, `flowdular.json`, generated composition, rules and deployment
  examples use Flowdular. CLI identity tests and the built CLI smoke passed.
  `packages/kernel/tests/runtime-config.test.ts` covers legacy environment
  aliases, explicit new values, existing state, ambiguous roots and symlinks.
  The compatibility regression was observed failing before implementation.
- Security: `modules/agents/src/services/run-grant.ts` still verifies HMAC before
  claims; its brand compatibility test accepts a signed old issuer and rejects
  tampered and expired grants. Workflow backend tests cover redaction with both
  old and new schema keys. Both permission annotations must be satisfied when
  present. Tenant identity, CSRF and RLS contracts were not relaxed.
- Compatibility: the kernel runtime-config subpath and its callers in the
  database provider, platform, CLI and sandbox were reviewed together. Existing
  state is selected as one directory, preserving database and vault ownership.
  Module discovery excludes both state roots. The sandbox constant export is
  retained alongside the new resolver. All 100 historical SQL files are
  byte-identical to the pre-task snapshot. SQL roles, tenant settings, cookies
  and migration identifiers retain their original persisted values.
- Lifecycle: directory selection performs two bounded filesystem checks and
  creates nothing. Environment normalization costs O(E) time and space for E
  variables. Preview children receive the parent-selected root through a fixed
  two-value allowlist; their filesystem ceiling and explicit environment remain
  restricted. Preview worker tests passed all 11 cases after the final edit.
  State migration still copies without deleting its source.
- UI: landing inspected at 1440x1000 and 390x844 with no horizontal overflow or
  browser errors, correct Flowdular title and flowdular.com canonical URL.
  Sandbox browser workflow passed in English and Polish, including mobile,
  approvals, gate failures and delivery failure feedback. This change adds no
  new screen states. Source geometry and generator for the woven #, plus all
  three favicon SVGs, match the original. Raster wordmarks were inspected;
  a preview image with a distorted symbol was rejected and replaced.

## Commands and results

- `pnpm install --no-frozen-lockfile`: passed.
- `pnpm rules:generate`, coding-agent `sync-roles`, and
  `pnpm flowdular module sync --apply`: passed.
- `pnpm verify`: passed, including typechecking, workspace tests, module/spec
  validation, generated-rule checks and formatting.
- Scoped kernel, grant compatibility, CLI state migration and sandbox preview
  tests: passed. Final sandbox typecheck: passed.
- Sandbox browser workflow and landing desktop/mobile checks: passed.
- Landing and create-flowdular production builds: passed.
- Plain `pnpm build`: failed because the existing platform build script defaults
  to PGlite while production provider configuration rejects PGlite. The same
  conflicting default was present in the pre-task snapshot.
- `FD_DATABASE_ADAPTER=postgresql FD_DATABASE_URL='' pnpm build`: passed, including
  CLI smoke and platform bundle. This exercises first-run composition and does
  not verify a deployed PostgreSQL connection.

## Verdict and remaining work

No actionable rename defect remains in the reviewed scope. Full default-build
verification remains incomplete because of the pre-existing build configuration
conflict above; the successful first-run build does not waive that failure.

External ownership and rollout remain unverified: this task did not register
flowdular.com, create GitHub/npm organizations, transfer the repository, publish
packages or deploy a site. The existing Git remote remains unchanged. Historical
sandbox source snapshots retain their original package dependencies. Existing
custom module consumers must migrate imports and workspace configuration to the
new public names before using the renamed packages.

Local command logs and the pre-task snapshot are under
`/tmp/flowdular-rename-baseline/`; they are session evidence, not committed assets.
