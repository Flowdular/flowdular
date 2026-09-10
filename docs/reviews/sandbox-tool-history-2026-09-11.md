# Sandbox tool history and container CI review

Release: `@flowdular/sandbox@0.2.7`, extending the earlier progress/routing review.

## Findings and behavior

- `ChatPane.tsrx` no longer truncates activity blocks to six entries. Every
  operation remains in its start position. `transcript.ts` pairs start/result
  events by optional call identity, including parallel operations on the same
  file. Legacy events pair only with one unambiguous pending operation. Turn,
  role and module boundaries prevent unrelated matches. Persisted logs are not
  rewritten. Adjacent progress pulses remain coalesced and blank reasoning is
  omitted.
- `ToolEvent.tsrx` shows the action, module-relative target, completion status
  and measured duration. Native details/summary exposes the recorded tool name,
  full target and differing completion detail. Failure is visible, and missing
  completion is labelled `No result`, never success. Unknown tool names remain
  available in details. The scroll follower respects an operator reading history.
- Claude and Codex preserve their native call ids; BYOK assigns per-turn ids.
  Claude retains up to 4096 characters for file paths, so a long workspace prefix
  cannot erase the filename at the old 200-character cutoff. Other detail limits
  remain unchanged.
- GitHub run 34538636264 passed `verify` and `postgres`. The container passed the
  repaired scaffold fixture, then exposed missing git and IPv6 fixture assumptions.
  The builder now installs git for real delivery tests. The IPv6 fixture keeps
  real DNS lookup and HTTP on ::1, removing only Node's ADDRCONFIG hint that filters
  IPv6 on BuildKit's loopback-only network. Its lookup spy is restored in finally.

## Review evidence

- Correctness/tests: native identity assertions failed before the mapping change
  (`/tmp/tool-identity-red.log`), then passed. The long-path assertion fails when
  the 200-character cap is restored (`/tmp/tool-path-red.log`). All 51 driver tests
  pass, including parallel BYOK success/failure against real temporary files.
  Five transcript tests cover full history, reverse completion order, failure,
  legacy ambiguity, turn/role/module boundaries and path shortening. Browser
  coverage asserts all 13 operations, keyboard expansion, original details,
  duration, running/failure/unconfirmed states, mobile containment and preserved
  reading position when the turn completes.
- Security: no new tool authority, write path, identity source, endpoint, database
  access or HTML injection. Details remain text nodes from existing event fields.
  UI pairing cannot change server decisions. No migrations or specs changed.
- Compatibility: optional callId fields preserve existing persisted transcripts
  and driver consumers. All three tool-emitting drivers were inspected. Native
  metadata comes directly from tool_use/tool_use_id and item.id. The initial
  session fetch already reads the complete chat; no server paging was hiding
  older events. No SDK/CLI/generator source or version changes are required.
- Lifecycle/performance: pairing is O(n) time and O(n) display memory; each call
  enters and leaves pending state at most once. The BYOK counter is local to the
  turn. The UI intentionally renders full history, so DOM size grows with the
  number of operations. Native disclosure retains no separate background work;
  scroll handling uses one ref and one existing DOM handler. DNS configuration
  changes exist only inside the test and are restored before listener cleanup.
- UI: inspected desktop and 390px mobile tool-history screenshots in
  `/var/folders/t1/sqwgr805159fdpsthprc_y6r0000gn/T/sandbox-workflow-vjXFgu`.
  Shared icons and semantic tokens, native keyboard disclosure, aligned EN/PL
  strings, visible error and in-progress states, reduced-motion support. Empty
  history remains the existing empty conversation; authorization is unchanged.
- Container: local BuildKit reproduction confirmed ADDRCONFIG removes ::1; the
  real IPv6 fetch passes with the fixture lookup setting. Runtime image/user is
  unchanged; git is installed only in the builder. No assertions are skipped.

## Validation

- Driver suite: 51 passed; transcript suite: 5 passed.
- Sandbox/driver typechecks: passed, including the DNS overload fixture.
- Browser workflow: passed with no page errors (`/tmp/transcript-browser-reviewed.log`).
- `pnpm build`: passed (`/tmp/transcript-build-final.log`).
- Pack and consumer smoke: passed (`/tmp/transcript-pack.log`, `/tmp/transcript-smoke.log`).
- Final repository verification: passed (`/tmp/transcript-verify-final.log`).
- Final path-display guard: scoped transcript tests and typecheck passed; shell
  commands retain their original spelling rather than path normalization.
- GitHub checks after the container fixes: pending push.

An intermediate verification reached the formatting check and failed on a test
edited during that run. Formatting was corrected before the final rerun. An
initial DNS spy signature failed typecheck; its explicitly typed all-addresses
lookup overload now passes both the real HTTP test and typecheck.

No outstanding code finding. Local review verdict: pass. GitHub execution after
the container fixes remains pending.
Old transcripts cannot recover paths already truncated by a previous driver, and
ambiguous legacy parallel calls remain separate instead of inventing a match.
