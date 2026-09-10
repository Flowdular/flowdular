# Standalone sandbox review

Verdict: pass for the sandbox extraction. Reviewed 2026-09-10 against
`2cc391f` and the scoped working-tree changes. The concurrent platform-release
work is outside this review; only its formatting was normalized.

## Evidence

- Correctness: `scripts/sdk-members.json`, `scripts/package-sdk.mjs`, and
  `scripts/sdk-packages.json` assemble four packages. The SDK excludes both
  `packages/sandbox` and `packages/coding-agent`, their exports and launcher.
  The standalone app owns its drivers and imports the SDK. The packed consumer
  test installs the app in a separate temporary tool directory, creates an edit
  session against a generated consumer, composes its module in an isolated worker,
  and observes a successful HTTP state response and SSR page.
  The launcher canonicalizes the npm binary symlink before comparing its entry
  path. The symlink regression failed with empty output on 0.2.0, then passed
  on 0.2.1. Actual `npm exec` against the 0.2.1 tarball also prints the expected
  help and workspace flag. Sandbox patch versions are independent of SDK versions.
- Security: `preview-worker-manager.ts` grants physical dependency-code roots
  and the session root, with writes limited to session data directories. It keeps
  Node permissions, the explicit environment allowlist and no child-process grant.
  The host resolves the consumer SDK path before starting the worker, so the
  loader does not need access to the consumer's platform metadata. Existing
  `preview-worker.test.ts` checks denied host reads, denied session-control writes,
  and permitted preview data writes; all 11 tests pass. No endpoint, identity,
  SQL, migration, CSRF or tenant policy changed. Archive inspection found no
  `.env`, `.flowdular`, `.git`, or `node_modules` state.
- Compatibility: `packages/cli/src/sdk.ts` preserves standalone imports while
  rewriting the platform `module-sandbox` access contract to SDK exports. The
  CLI regression passes. The standalone 0.2.1 manifest depends on SDK 0.2.0 with no
  workspace or other Flowdular dependencies. Packing rejects dependency conflicts.
  A 190-module browser build contains no server/database/coding application code.
  Removing SDK sandbox and coding-agent exports is an intentional 0.2.0 change;
  callers use the standalone package. The platform access/grant module remains.
- Lifecycle: existing worker cancellation, deduplication, timeout, database
  retention and cleanup tests pass. Permission-root discovery is O(path depth);
  source transformation is O(source bytes) per loaded module and uses Node's
  module cache. The loader is limited to the app and resolved SDK roots.
  Smoke processes have readiness/operation deadlines and are terminated in
  cleanup. Temporary consumer fixtures are retained for diagnosis, consistent
  with the existing SDK smoke workflow.
- Tests: the smoke failed before extraction on the missing package; later runs
  reproduced unsupported TypeScript in installed dependencies, then the separate
  consumer SDK loader failure and denied metadata read. The final unmodified
  packed runner passes those same scenarios. `pnpm release:pack`,
  `pnpm release:smoke`, sandbox typecheck, and `pnpm build` pass on Node 24.18.0.
  The final `pnpm verify` passed all stages, including all 246 sandbox tests.
  Earlier attempts encountered formatting of the concurrently added
  `scripts/platform-release.mjs` and two intermittent timeout/abort failures in
  `routes.test.ts` and `preview-worker.test.ts`. Formatting was normalized;
  all 23 tests in those two suites passed with one worker, followed by the
  successful full verification with the normal configuration. No timeout,
  assertion, isolation setting or gate was weakened. `git diff --check` passes.
- UI: this changes package ownership and startup only, without changing rendered
  components, translations or keyboard behavior. The packed application's HTTP
  smoke verifies the existing SSR page loads; no visual redesign is involved.

Publication verified: SDK, CLI and generator 0.2.0, plus sandbox 0.2.1, are on
npm and match the local archive integrity hashes. A new application generated
and installed entirely from npm passes module validation. The real
`npx @flowdular/sandbox@0.2.1` prints help and serves both its state API and SSR
page for that application. Sandbox 0.2.0 was deprecated because its npm binary
symlink did not execute the launcher.

No actionable findings remain in the extraction. Remote authenticated platform
linking and paid provider calls were not exercised; the preview smoke uses the
fake driver.
