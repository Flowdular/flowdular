# Sandbox progress, repair routing and preview review

Release: `@flowdular/sandbox@0.2.7`.

Scope includes the pending composer Settings change, driver progress and timeout
handling, diagnostic ownership routing, preview hot updates and installed SDK
review references. The user's running sandbox and draft were inspected read-only.

## Findings reproduced and fixed

- The reported Claude process remained alive after a Read completed in roughly
  40 ms. It later resumed edits after a long generation interval. Complete native
  transcript blocks alone do not distinguish quiet generation from a provider
  stall. `claude-code.ts` now emits activity on incoming partial deltas, throttled
  to one pulse per ten seconds, in addition to block starts. Blank reasoning is
  discarded. `TurnActivity.tsrx` reports the age of the last received update;
  `ChatPane.tsrx` coalesces adjacent pulses and marks ongoing activity correctly.
- `spawnLineStream` previously reported both timeout and operator stop as aborted.
  Both native drivers now throw `DRIVER_TIMEOUT` for an exhausted time limit. The
  turn route records failure and blocks continuation. Abort listeners and kill
  timers are cleaned up; manual cancellation remains resumable.
- `planning.ts` returned failed gates to the finishing role. In the reported
  session the manifest diagnostic named client files, while backend tests passed.
  `gate-repair.ts` reads structured manifest issue paths and compiler/test paths,
  selects a registered owner with matching write paths, and retains the diagnostic
  module only when it belongs to the session. The repair prompt includes recorded
  gate statuses. Unknown output retains the previous routing fallback.
- Octane's installed hotUpdate hook broadcasts full-reload for changed TSRX files
  even when they belong only to a preview. `preview-hot-updates.ts` wraps those
  hooks for session files, invalidates Vite client and SSR module caches, and
  suppresses the global reload. Application source still uses normal Octane HMR.
- `prepareAutoReview` directly copied a missing application-local skill. It now
  shares `referenceSource` with session materialization: local override first,
  otherwise the installed SDK. The user's installed SDK contains the skill.

## Review checks

- Correctness: driver timeout/activity tests failed on the original behavior
  (three failures), then passed. Client diagnostic and cross-module routing tests
  failed before the routing fix (three failures), then passed. The actual Octane
  hooks emitted forbidden reloads before isolation (two failures); both cache
  invalidation and ordinary application reload cases now pass. The SDK-only
  review fixture reproduced the same ENOENT, then passed with the fix and with
  a local override. Route integration asserts one attempt, blocked handoff and
  no gates after timeout. The pre-existing user cancellation/resume test passes.
- Security: no permission or role ceiling expansion, spec approval or database
  changes. Diagnostic text is not executed as instructions. Routing is restricted
  to session modules and registered role write globs; tests reject out-of-session
  modules, warning-only locations and traversal. Existing turn authorization and
  path enforcement remain authoritative. Review still fails if neither skill
  source exists; it never grants approval or bypasses a gate.
- Compatibility: no new package dependency or public endpoint/request field.
  ProcessLineStream adds an internal timedOut result consumed by both native
  drivers. Existing activity event schema and session data remain compatible.
  The HMR adapter uses the installed Octane plugins and preserves hook order and
  receiver for ordinary source files. SDK fallback uses the same package.json
  resolution already used by reference materialization. No migrations changed.
- Lifecycle/performance: activity parsing remains linear in stream length with
  constant retained state; additional durable pulses are limited to six per
  minute during one long block. UI keeps one interval only while running, clears
  it on unmount, and coalesces consecutive pulses. Routing parses at most 16 KB,
  then checks diagnostic locations against the finite role/module sets. HMR
  invalidation touches only graphs for the changed file and adds no watcher or
  background timer. Process abort listener and kill timer are released on exit.
- UI: desktop/mobile workflow regression passes with no page errors. It covers
  elapsed quiet time, active indicator, removal after completion, disabled fresh
  context while running, Settings keyboard interaction and mobile containment.
  A real temporary draft save changes the transformed module without reloading
  the browser page or losing unsent text. Temporary files are removed afterward.
  Inspected artifact: sandbox-workflow-dvarVr/quiet-agent.png. English/Polish locale
  keys are aligned; motion respects prefers-reduced-motion.

## Validation

- `pnpm --filter @flowdular/coding-agent test`: 49 tests passed.
- Scoped sandbox runtime: 61 tests passed; routes: 16 tests passed.
- SDK review plus actual Octane hook regressions: 11 tests passed.
- Browser: passed, including real Vite draft invalidation and retained composer.
  `/tmp/stall-browser-final.log`; artifacts under
  `/var/folders/t1/sqwgr805159fdpsthprc_y6r0000gn/T/sandbox-workflow-dvarVr`.
- Sandbox typecheck: passed (`/tmp/stall-latest-types.log`).
- `pnpm build`: passed (`/tmp/stall-build-final.log`).
- `pnpm release:pack`: passed, four public artifacts; only sandbox is bumped.
- `pnpm audit --prod --audit-level high`: passed, no known vulnerabilities.
- Final `pnpm verify`: passed (`/tmp/sandbox-fixes-verify-final.log`), including
  all 272 sandbox tests and repository formatting.
- Packed consumer smoke: passed (`/tmp/sandbox-027-smoke.log`), including
  installed sandbox 0.2.7, HTTP/SSR and isolated preview composition.

One full verification attempt exposed a browser-fixture cleanup issue: creating
`.flowdular` alongside this repository's existing `.coreloom` state. The test now
uses the existing state directory; its empty temporary directory chain was
removed without touching application data. The browser suite passes again.

## Container CI regression

GitHub run 34536151329 passed `verify` and `postgres`, but `container` failed at
`packages/cli/tests/module-scaffold.test.ts`. Its chmod-based failure fixture
allowed writes by the root user in the Docker builder. The test now places an
empty directory at the planned translation file path, causing a real EEXIST
write failure after earlier scaffold files have been written. It retains the
rollback and successful retry assertions, and additionally checks that existing
specification bytes, translation bytes and the conflicting directory survive.

- Scoped scaffold suite: all 5 tests passed (`/tmp/ci-scaffold-fix.log`).
- Mutation check: disabling file rollback makes the regression fail; restoring
  production code makes it pass (`/tmp/ci-scaffold-mutation.log`).
- The same file collision rejects with EEXIST under uid 0 in the actual
  `node:24-bookworm-slim` builder image.
- CLI typecheck and scoped Prettier check passed after the test-only change.
- No workflow gates, runtime permissions or product code changed for this fix.
  No sibling chmod-based rejection fixtures remain in package tests.
- GitHub verification of all three jobs remains to be observed after push.

No unresolved actionable finding in the reviewed code. Local review verdict:
pass. Provider latency
is not eliminated; the UI now distinguishes incoming progress from elapsed quiet
time without claiming that silence proves a dead process. These changes are local
and have not replaced the user's running npm installation.
