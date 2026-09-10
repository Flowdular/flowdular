# Shared SDK publication review

Date: 2026-09-10. Verdict: pass for the three-package implementation and local artifact verification. This replaces the 25-package publication proposal in the earlier distribution review. npm publication and public/private catalog access remain separate operator follow-up.

## Public surface

Only `@flowdular/sdk`, `flowdular` and `create-flowdular`, each at `0.1.0`, appear in `scripts/sdk-packages.json` and the verified artifact manifest. Internal library and core-module workspaces are private. `scripts/sdk-members.json` defines the source assembly; SDK exports preserve separate client, server, UI and core-module entrypoints. There is no root barrel. UI is part of the SDK, including `ui/styles`.

The CLI package contains bundled JavaScript and exposes `flowdular/distribution`. The generator supports `npm create flowdular@latest my-app`; its pnpm workspace installs with pnpm even when npm launches the generator. A missing pnpm binary falls back to the pinned pnpm version through npm exec. Explicit unsupported package-manager selection is rejected before creating the application.

## Evidence by requirement

- Package boundaries: `scripts/package-sdk.mjs` assembles exactly three packages, rejects unbundled internal dependencies and conflicting dependency versions, and uses an owned temporary staging directory removed in `finally`. Repacking after staging isolation produced identical SHA-256 values for all three tested artifacts. Previous individual tarballs were moved outside the active publication directory.
- Clean installation: `scripts/smoke-sdk.mjs` runs the generator from its tarball, installs only packed public packages, installs all three current official-module source artifacts, enables their composition, validates the source lock, typechecks and runs 155 tests. No symlink or source alias points back into core.
- UI isolation: `scripts/smoke-sdk-boundaries.mjs` builds a UI import using the actual Octane/Vite compiler. The 190-input browser graph contains no SDK server, database, agent, sandbox or core-module inputs, and no Node-only fallback module. The packed sandbox launcher also exits successfully with `--help`.
- CLI discovery and enable/disable: `packages/cli/src/sdk.ts`, `module-files.ts` and `module-sync.ts` discover the SDK module index, preserve local-source precedence, generate SDK imports and retain the shared SDK dependency when disabling a single bundled module. `module-sync.test.ts` verifies the generated imports and retained dependency.
- Approved specifications: `sdkScaffold` adapts generated imports and dependencies but preserves the exact specification and manifest bytes. `tests/sdk.test.ts` exercises a specification containing an old import name. Restoring the original rewrite defect in a disposable copy causes this regression test to fail; the real 96-test CLI suite passes.
- Sandbox reference ownership: `reference.ts` falls back to installed SDK references when the consumer has no core checkout. Copy exclusions apply below the resolved source root, allowing SDK source within node_modules while excluding nested build/dependency directories. The new regression initially exposed the exclusion defect, then passed with the fix; the complete sandbox suite passes 231 tests.
- Official modules: expenses/catalog `0.6.1` and parties `0.8.1` consume SDK subpaths. Manifest/package/specification versions align. Applied migration files are byte-identical to the previous release commit. The new artifacts carry current source-bound review evidence. The three bootstrap entries requiring unpublished individual packages were withdrawn from the active catalog; their immutable artifacts remain in history. Regenerating the index preserves the three current entries.

## Executed checks

- `pnpm verify`: exit 0, 1,227 tests passed, with rules, pinned reference, typechecking, validation and formatting passing. The default run skips three PostgreSQL-only tests; those ran successfully in the separate PostgreSQL check below.
- `pnpm build`: exit 0, including CLI smoke and the production platform client/server build.
- `pnpm --filter @flowdular/cli test`: 96 passed; generator tests: 33 passed.
- Official-modules `pnpm verify`: 147 passed with typechecking and module validation against the assembled SDK.
- Clean packed consumer: 155 passed, typecheck and locked validation passed, UI browser build and sandbox launcher checks passed.
- Disposable PostgreSQL cluster: database-testing plus all official-module suites, 154 passed with no skips. Runtime roles were NOSUPERUSER/NOBYPASSRLS; the cluster was stopped and removed.
- `npm exec --package=<generator tarball> -- create-flowdular my-app --no-install --no-git`: exit 0 and a generated application present.
- `node scripts/publish-sdk.mjs`: preview only, exactly three names/versions and matching artifact digests. No npm publication occurred.

## Security, lifecycle and limitations

No endpoint, tenant permission, SQL policy, secret handling or business UI behavior was changed by consolidation. Source import targets and package ownership changed; real consumer and PostgreSQL tests cover those boundaries. SDK assembly is linear in copied source bytes, with temporary files owned by the packer. Module-index discovery is bounded to 256 records and checks paths remain inside the SDK. Existing install/download/recovery limits remain in force.

The final read-only review found no remaining actionable defect in this scope. Tests and review are evidence, not a correctness guarantee. npm currently returns no public version for these three package names; this is not a claim of publication rights. Repository CI and fresh registry installation must be checked after publication. Official-modules remains private and anonymous catalog fetch returns 404; public visibility or authenticated distribution still requires a decision. Core changes remain in the existing local working tree, preserving unrelated edits.
