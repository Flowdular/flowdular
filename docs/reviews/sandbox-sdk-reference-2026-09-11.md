# Sandbox installed SDK reference review

Release: `@flowdular/sandbox@0.2.8`, alongside the attachment snapshot fix.

## Behavior and evidence

SDK symlinks in generated apps resolve into pnpm storage outside a sandbox
session. The existing physical-containment check correctly refuses that read.
`sdk-reference.ts` resolves the SDK from the host application's platform package
and copies its package/module sources and export manifest to `reference/sdk`.
It never grants access to external paths. `reference.ts` prepares new sessions;
`turns.ts` also prepares old sessions before driver invocation and the path guard.
The role instruction and root agent pointer name the readable SDK location.

The new reference test failed before the implementation because the SDK source
was absent (`/tmp/sdk-reference-red.log`). It now proves the physical read succeeds,
external symlink access and SDK writes remain denied, out-of-role changes are
restored, and the installed source stays unchanged. It exercises excluded hidden
files, node_modules and symlinks, reuse without copying, replacement after a
manifest/version change, removal of obsolete files and recovery of a deleted
snapshot. A route/driver test simulates an old session by removing its SDK copy;
the real turn runner restores it and the driver reads both SDK and attachments.

## Review checks

- Correctness: reference and attachment integration suites pass, 25 tests
  (`/tmp/sdk-reference-integration-final.log`). The complete sandbox suite passed
  283 tests before the additional old-session integration assertion. The final
  repository run includes that assertion. The no-SDK authoring workspace keeps
  its existing curated platform references; SDK snapshots apply to installed SDK
  consumers. Sources are selected from the host app, not the npx sandbox runner.
- Security: existing physical containment and role allowlists are unchanged.
  Source symlinks, hidden state and dependency trees are excluded. Reference
  parent symlinks are rejected and target symlinks are removed without following
  them. Metadata and staging remain outside the agent workspace. The real guard
  test restores an attempted SDK edit and confirms the original source bytes.
  No new endpoint, DB, tenant identity, permission or network behavior.
- Compatibility: existing reference paths remain available. Agent pointers gain
  SDK guidance only when an SDK exists. Cache identity uses the resolved
  installation and exact package manifest. Old sessions gain the copy on their
  next turn. Public source exports and module paths retain SDK layout. SDK/CLI
  releases are not needed for this host-only fix.
- Lifecycle and performance: initial copy is O(source file count + bytes), with
  sequential traversal. Cache reuse reads bounded manifest/marker files and
  avoids scanning or copying the SDK. Staging is removed in finally. Failed
  preparation never starts a driver; missing snapshots can be rebuilt. On the
  user's installed 6.1 MB SDK, an isolated temporary-directory measurement took
  211 ms initially and 1 ms cached. These are one local measurement, not latency
  guarantees. Installed package contents are treated as immutable; manually
  editing node_modules without changing the manifest is unsupported.
- UI: no rendered component or interaction changes. The agent receives explicit
  source locations and scoped-search instructions. The user's active session
  was not modified or restarted.

## Validation

- SDK/reference regression tests and attachment integration: passed.
- Sandbox typecheck: passed (`/tmp/sdk-reference-types-final.log`).
- Full `pnpm verify`: passed (`/tmp/sdk-reference-verify.log`), including all
  283 sandbox tests and the old-session integration assertion.
- `pnpm build`: passed (`/tmp/sdk-reference-build.log`).
- Pack and clean-consumer smoke: passed (`/tmp/sdk-reference-pack.log`,
  `/tmp/sdk-reference-smoke.log`). The generated app passes verify and build;
  the separately installed sandbox passes startup and isolated preview.

No actionable code finding after review. Final local review verdict: pass.
