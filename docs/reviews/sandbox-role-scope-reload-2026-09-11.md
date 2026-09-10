# Sandbox role scope and reload logging review

Release: `@flowdular/sandbox@0.2.6`.

## Evidence and behavior

The reported session reused one Claude conversation for specification work and subsequent backend turns. Its last backend turn changed client files, which the existing path guard quarantined and restored. Reuse across roles is a concrete context-isolation defect; the transcript alone cannot establish every reason for the model's edits.

`turns.ts` now keys provider resume identifiers by the instruction, approved spec hash and configured model. The instruction contains the role, module, task skill and exact write ceiling. A different scope or legacy unscoped identifier starts a fresh conversation with the brief and recent messages. Same-scope continuation still resumes. Only one identifier per driver is retained, so repeated handoffs do not grow the map. Drafts, approvals, transcripts and quarantined evidence are not deleted or restored by this change.

`roles/registry.ts` previously replaced an explicitly empty write list with role defaults. That contradicted read-only auto-review. It now preserves the supplied list and renders an empty list as `none (read-only)`. The shared contract explicitly limits each specialist to the portions of a skill within its role and write scope.

`reload-log.ts` groups repeated saves over a fixed 750 ms window into English summaries, such as `Draft blog (96a64f10) · 4 files changed`. Verbose mode retains paths. Summaries report source changes, not successful builds. The logger counts add/change/unlink, ignores unrelated external state, caps pending unique paths at 256, and removes its listener and timer on server shutdown. The launcher retains existing error reporting.

## Review checks

- Correctness: the route regression fails with the old shared resume key and passes with manager/backend/frontend handoffs, same-role continuation and legacy migration. The read-only regression fails with the old fallback and passes with the explicit empty ceiling.
- Security: no widened role permissions, approval bypass or quarantine recovery. Existing authenticated/tenant-scoped turn routes and post-turn path enforcement remain in place. No credentials are introduced into keys or logs; scope hashes are not printed.
- Contracts: `resumeIds` remains a string dictionary; old entries are replaced on the next completed attempt. All known readers are session storage and the turn runner. The instruction context already requires explicit allowed paths. No database, migration, module manifest, generated composition or SDK public surface changed.
- Lifecycle and complexity: resume hashing is O(instruction length), key selection O(driver count), with at most one retained identifier per driver after migration. Logging is O(path length) per event with O(1) set/counter updates and O(unique paths) flush, at most 256 pending paths. The fixed window cannot be postponed indefinitely by continuous writes. Shutdown clears pending logs and detaches callbacks.
- Tests: 46 coding-agent tests and 15 scoped route tests passed. Three logger tests cover duplicate aggregation, verbose paths, close cleanup, add/unlink, separate session labels and ignored state. A five-notification burst over three unique files produces one summary.
- UI: no layout or control change. Terminal output is asserted in English. Existing system messages use the existing transcript rendering. Packed HTTP/SSR smoke covers the launcher integration.

## Validation

- `pnpm build`: passed.
- `pnpm release:pack`: passed; exactly four public artifacts, only sandbox version changed.
- `pnpm verify`: passed, including all 261 sandbox tests; `/tmp/role-verify-final.log`.
- `pnpm release:smoke`: passed; packed launcher, HTTP state, SSR and isolated preview compose against a generated consumer; `/tmp/role-smoke.log`.

## Limits

Conversation isolation improves instruction consistency but does not guarantee model compliance. The path guard remains the enforcement mechanism. Existing quarantined client edits have not been automatically applied. A fresh conversation preserves the brief and recent messages, not every earlier native tool result. Optional external PostgreSQL suites retain their existing environment-dependent skips; no new test is skipped.

## Verdict

Pass. All applicable checks completed. No unresolved actionable finding in this change.
