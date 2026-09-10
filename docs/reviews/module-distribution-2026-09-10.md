# Module distribution delivery review

Date: 2026-09-10. Verdict: pass for the implemented distribution and repository extraction scope. npm publication and hosted CI remain operator follow-up, not completed publication claims.

## Scope and requirements

Reviewed the CLI artifact/catalog/install/recovery implementation, module discovery and composition callers, kernel compatibility checks, contracts and schemas, SDK packing and clean-consumer scripts, scaffold changes, pinned sandbox reference, build isolation and extracted repository release tooling. Existing unrelated workspace changes were preserved. This review does not certify all historical code or close the production backlog in the system audit.

| Scenario                                                                      | Implementation and executable evidence                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview writes nothing; apply installs editable source into configured roots  | `packages/cli/src/module-install.ts`; `module-distribution.test.ts` previews, applies, retries and validates the resulting lock through the CLI                            |
| Reject tampered content, stale reviews, unsafe paths and symlink destinations | `module-artifact.ts`, `module-catalog.ts`; distribution tests exercise digest mismatch, stale source evidence, traversal and destination links                             |
| Preserve local edits and migration history during updates                     | Installer compares all source hashes and every historical migration; tests reject edited and extra files, migration changes and downgrades                                 |
| Recover interrupted installation without discarding conflicting work          | Exclusive transaction directory, staged writes, journal and backups; tests cover dead/live owner recovery and layout failure preserving existing source                    |
| Enforce compatible dependencies, including diamonds                           | Shared kernel semver validation and bounded catalog resolution; registry and distribution tests reject invalid ranges, backtrack compatible diamonds and reject cycles     |
| Preserve offline sandbox examples after removing catalog from core            | Provenance-bound `.ai/references/catalog`; reference check and sandbox module-reference test pass without bundled catalog                                                  |
| Source releases work outside the authoring workspace                          | Packed 25 SDK artifacts; clean scaffold installs all three official source artifacts, enables composition, checks lock and runs typechecking and 155 tests                 |
| Build never uses deployment DB state or keys                                  | Disposable build state and keys in `platform/scripts/build.mjs`; build-isolation test checks deployment settings remain untouched and production bundling mode is retained |
| Retain review enforcement                                                     | Sandbox auto-review tests cover missing, stale, malformed and failed reports, changes after review, skipped gates and missing module results; 230 sandbox tests pass       |

## Security, compatibility and lifecycle

Source installation is a host capability and grants no sandbox network or tool authority. It neither runs downloaded lifecycle scripts nor activates modules, grants tenant scopes or performs migrations. Enablement remains explicit. The official HTTPS repository is the trust root; hashes and review records do not authenticate a malicious publisher.

All source is validated before destination changes. Updates recheck source and lock immediately before replacing files. Recovery refuses live owners and preserves conflicting edits. Downloads are limited to 30 seconds, 4 MiB catalog and 48 MiB per artifact; aggregate artifact bytes are capped at 96 MiB. Source artifacts are limited to 4096 files and 32 MiB decoded source. Dependency resolution is bounded at 10,000 search steps and 256 selected modules. Hashing is linear in source bytes; candidate sorting is O(R log R); dependency search may backtrack exponentially but stops at its explicit budget.

The three extracted modules retain source handlers, permissions, tenant SQL, specifications and migration bytes. Only package distribution metadata and licenses changed during extraction. Applied migrations were not rewritten. Cross-module harness tests moved with their consumers and still exercise real module repositories. Published baseline modules resolve through package exports; local editable source takes precedence for its package. Existing module manifests can omit the new optional platform API field, while distributed releases must declare it.

No business screen or translation was redesigned. The repository banner uses the existing Flowdular logo copied byte for byte from landing, with editable SVG typography and a module diagram. README links and asset paths were inspected. Landing's standalone build and its 18 tests passed after the SEO update; concurrent subsequent landing edits are outside this review.

## Actual validation

- `pnpm verify`: exit 0, 1,224 tests passed; the three PostgreSQL-only tests skipped in the default embedded run were subsequently executed successfully in the PostgreSQL matrix below. Typechecking, rules, reference, schema/layout/dependency validation and formatting passed.
- `pnpm build`: exit 0, including CLI build/smoke and production client/server bundles. Upstream PGlite eval and sourcemap warnings remain non-fatal.
- `pnpm --dir ../official-modules verify`: exit 0, 147 tests passed, all typechecks and module validation passed.
- `pnpm release:pack`: 25 SDK tarballs generated with hashes. `node scripts/publish-sdk.mjs`: preview only, all digests verified; nothing published to npm.
- `node scripts/smoke-sdk.mjs release-artifacts/sdk ../official-modules/registry/local-index.json`: exit 0; separate consumer, no core-source symlinks, 155 tests passed and typechecking/locked validation passed.
- Temporary PostgreSQL cluster with `NOSUPERUSER NOBYPASSRLS` migrator, runtime and background roles: 586 tests passed, no skips. Ran database-testing, auth, agents, profile, sandbox, automations and workflows plus all official-module tests. The isolated cluster was stopped and removed afterward. Initial test setup used the wrong role names and failed migration preconditions; correcting the fixture to the CI role names made the complete matrix pass without code or assertion changes.
- Regression mutation: in a disposable kernel copy, removing the dependency-version guard made the new registry regression fail (one failure, four passes). The real implementation passed its 51-test kernel suite.
- Official release packaging confirmed all three source artifacts still match their review evidence and immutable bytes.

## Remaining boundaries

No actionable defect was found in this reviewed scope. The user must publish the exact npm versions listed in `docs/npm-publication.md`; registry-based clean installation and hosted CI can only be completed afterward. Official-modules CI needs a portable lockfile after those packages become available. Existing identity, delivery, retention and other production issues remain tracked in `system-audit-2026-09-10.md`. Review and passing tests reduce defects; they do not guarantee arbitrary model output is correct.
