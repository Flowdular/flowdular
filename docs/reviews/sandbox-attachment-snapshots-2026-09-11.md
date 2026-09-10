# Sandbox attachment snapshot review

Release: `@flowdular/sandbox@0.2.8`.

## Root cause and acceptance evidence

Operator uploads wrote into `workspace/reference/attachments` during a running
turn. The path guard correctly rejected these changes against its earlier
snapshot, but attributed them to the agent and removed them. The private files
survived; later turns advertised paths without rebuilding their workspace copies.
A second race let concurrent uploads overwrite session attachment metadata.
Both scenarios failed before the fix (`/tmp/attachment-red.log`): the guard
reported forbidden reference writes, and three uploads left one recorded file.

`attachments.ts` now writes uploads only to private session storage. `turns.ts`
materializes the current attachment list before composing the prompt and taking
the guard snapshot. Operator removal preserves the running turn's copy until the
next turn. Missing workspace copies are rebuilt from recorded private sources.
`session-lock.ts` serializes attachment changes with `sessions.ts:updateSession`,
so state updates and same-name uploads preserve the latest record.

## Review checks

- Correctness: attachment tests exercise real files, the real path guard and HTTP
  routes. They cover upload during a turn, three concurrent same-name uploads,
  mixed session updates, failed-operation recovery, removal during a turn,
  restoration of missing copies, and the driver's actual file read. The latter
  result is asserted outside the driver so turn error handling cannot hide a
  failed assertion. Existing image serving, size/type limits, naming, initial
  brief attachments and deletion checks remain enabled.
- Security: reference writes remain forbidden to agents. No path allowlist or
  authorization was widened. Materialization refuses a symlinked reference
  directory, replaces the attachment directory without following its symlink,
  validates target containment and creates fresh files exclusively. Existing
  route authorization, mutation checks, UUID validation, MIME checks and 5 MB /
  ten-file limits remain. Symlink rejection, traversal, missing authorization
  and invalid upload tests pass. No database, tenancy or migration changes.
- Compatibility: HTTP payloads and persisted attachment records are unchanged.
  Existing partial `updateSession` callers still work; the new functional form
  reads and updates under the same queue. Active turn metadata patches preserve
  attachment changes. Existing sessions need recorded metadata and private bytes
  to recover a missing workspace copy. Explicitly removed attachments are not
  resurrected. No SDK, CLI or generator change is needed for this fix.
- Lifecycle: queued operations release in finally, including validation failure;
  idle session keys are removed. Files are copied sequentially before driver
  startup, O(total attachment bytes) time and at most one file buffer at a time,
  bounded by existing upload limits. Upload/removal during a turn cannot mutate
  its snapshot. A failed preparation does not start the driver and can be retried.
  The queue is process-local, matching the single sandbox server runtime; running
  multiple sandbox servers against one session remains unsupported.
- UI: no rendered markup, styling, localization or keyboard handler changed.
  The existing paste handler already uploaded the images shown in the user's
  screenshot. The defect and correction are in host file ownership and storage.
  The user's live session was inspected read-only and was not modified.

## Validation

- Scoped attachment suite: 22 passed (`/tmp/attachment-green-final.log`).
- Complete sandbox suite: 282 passed (`/tmp/attachment-suite.log`).
- Sandbox typecheck: passed (`/tmp/attachment-types.log`).
- `pnpm verify`: passed (`/tmp/attachment-verify.log`). Existing PostgreSQL-only
  suites are conditional locally; database behavior is unchanged.
- `pnpm build`: passed (`/tmp/attachment-build.log`).

No actionable code finding after review. Local review verdict: pass.
