# Terminal ASCII brand review

## Scope

`dev-console/src/brand.mjs` renders the existing Flowdular crossed-thread symbol
in ASCII. Platform and sandbox ready blocks share it through `printReady`.
The generator completion block and interactive CLI setup/help use the same
Vite-free subpath. The symbol occupies its own block above the title and subtitle, each on its
own line. Terminals narrower than the mark omit it; redirected output preserves
the previous one-line heading. All active segment-state dependency pins, the
application template and module scaffolder move to 0.2.1. The immutable catalog
reference remains unchanged. Generated applications explicitly decline the
optional tldjs postinstall, matching the platform build policy.

## Review

- Correctness: the three brand tests cover redirected output, printable ASCII,
  terminal width, stacked captions and monochrome readability. CLI and generator typechecks pass.
  The actual `pnpm exec tsx src/index.ts help` command was inspected in a PTY:
  the symbol and Application toolkit caption render above the existing help.
  Platform/sandbox callers retain their status rows and use the shared header.
- Compatibility: the brand subpath has a declaration file and no runtime imports.
  It does not load Vite into CLI/generator startup. Existing exports remain.
  CLI JSON output bypasses the heading even in a terminal. No command dispatch,
  flags, errors or interactive prompts change. Non-TTY output remains compact.
  New workspace dependencies are declared and the lockfile is updated.
- Security: fixed product labels only; no new user data, credentials, filesystem,
  network, database, tenant or permission behavior. No migrations/spec changes.
- Lifecycle/performance: a constant nine-row mark is rendered synchronously.
  The renderer adds no timer, watcher, animation, subprocess or retained state. Existing
  color selection and NO_COLOR behavior are preserved by callers.
- UI: ASCII is based on the supplied Flowdular mark. Wide PTY output was inspected
  directly; narrow and redirected variants are covered by assertions. Color is
  optional. Product copy remains English and existing status/error rows remain.
- Release scope: SDK 0.2.4 carries the shared developer console, CLI 0.2.4 and
  generator 0.2.6 bundle the Vite-free renderer, sandbox 0.2.9 adopts the new SDK.
  Generated application dependencies are updated together to the new SDK.

## Validation

Scoped tests and CLI/generator typechecks passed (`/tmp/ascii-scoped.log`).
All 14 JavaScript source maps in the installed segment-state 0.2.1 artifact
contain their sources. Declaration maps still reference absent TypeScript source
files; those are not the Vite JavaScript sourcemap warning reported here.
The missing generated-app policy was reproduced with a normal forced install:
`ERR_PNPM_IGNORED_BUILDS: tldjs@2.3.2`. Adding `tldjs: false` made that install
pass and `pnpm flowdular doctor --json` returned `ok: true`, `status: healthy`.
The tldjs postinstall only fetches updated domain rules when explicitly opted in;
its bundled rules are sufficient. `scripts/smoke-sdk.mjs` now runs a normal
consumer install instead of `--ignore-scripts`, so this policy is exercised.
Evidence: `/tmp/pnpm-build-policy-fixed.log`, `/tmp/pnpm-doctor-fixed.log`.

`pnpm verify` and `pnpm build` passed for the final source
(`/tmp/terminal-release-verify.log`, `/tmp/terminal-release-build.log`).

Packed consumer verification found a sandbox workspace YAML defect: stripping
only the `overrides` header left its mapping entries below a release-age list,
so installation failed and isolated preview could not resolve the SDK.
`packages/sandbox/src/server/workspace-install.ts` now edits the YAML document
structurally, preserves host policy and unrelated overrides, replaces workspace
package globs and links the installed SDK. Draft overrides are removed so imports
continue to resolve the draft. YAML parsing costs O(configuration bytes), with
no additional background work. Host configuration is trusted operator input;
no agent build-script grants are added. Invalid YAML fails before being written.
The SDK session regression failed against the original implementation and passes
with the fix (`/tmp/sandbox-yaml-before.log`, `/tmp/sandbox-yaml-after.log`).
The sandbox declares its existing-version YAML parser dependency explicitly.
The full sandbox suite also caught deletion below an absent overrides map; the
fix checks path existence first. An old runtime assertion compared YAML quote
style, so it now compares the parsed complete override map, still proving the
host link is present and the draft link is absent. The focused runtime and SDK
session suites pass all 62 tests (`/tmp/sandbox-yaml-focused.log`).

Final validation passed:

- `pnpm verify`: typecheck, tests, validation, rules/reference checks and formatting.
  Sandbox: 32 files, 283 tests passed.
- `pnpm build`: CLI smoke, module composition and platform client/server builds.
- `pnpm release:pack`: exactly four public artifacts.
- `pnpm release:smoke`: normal fresh installation, doctor, RuleSync, demo setup,
  app verification/build, browser dependency boundaries, separately installed
  sandbox launcher, HTTP/SSR/font serving and isolated module preview all passed.
  Evidence: `/tmp/terminal-release-pack.log`, `/tmp/terminal-release-smoke.log`.
- No segment-state JavaScript sourcemap warnings or ignored-build failures in
  final build and packed consumer logs. The upstream declaration-map limitation
  noted above remains; unrelated Node experimental notices remain visible.
- `git diff --check` passes. Final code, tests, manifests, lockfile, renderer and
  all callers were reviewed again after the YAML fixes.

Verdict: pass. No unresolved actionable finding within this change. The user's
original terminal error lacked a package name; the tldjs failure was reproduced
independently, so it cannot prove every possible build-policy failure is fixed.
