# RFC 0006 wave 2b, Stream F: data adapters (2026-09-16)

Branch `feat/data-adapters`, from main `e8ae391` (platform API 0.1.18). RFC 0006
J4: the runtime the spec section `adapters[]`, its scaffold and the
`integration-adapter` skill point at.

## What landed

- Module `adapters.core` 0.1.0 (`modules/adapters`, `@flowdular/module-adapters`),
  optional, dependencies `system.core` and `auth.core`, provides
  `adapters.sources.v1` and `adapters.sinks.v1`, requires (all optional)
  `connectors.calls.v1`, `connectors.instances.v1`, `import.ports.v1`,
  `import.write.v1`, `exports.lists.v1`, `metering.meters.v1`. Permissions
  `adapters.runs.read` and `adapters.runs.manage`, owner defaults only.
- Registration (`src/domain/registry.ts`, `src/services/registry.ts`):
  `register(moduleId, adapters)`, each entry with `id`, `direction`, `label`,
  `connector`, `operation`, `port`, `schedule`, `mapping` and optionally
  `recorded`, `input`, `items`, `paging`, `mode` and `batchSize`. An id
  outside the module, a direction that does not match the capability, a
  duplicate, a sink port outside the module, a malformed cron (the automations
  grammar), mapping, path, paging, bound or fixture throws
  `ADAPTER_REGISTRATION_INVALID`; a refused call keeps nothing; `start` seals the
  catalogue (`ADAPTER_REGISTRY_SEALED`).
- Tables (migration `0001_adapters_core`, mirrored): `adapter_bindings`,
  `adapter_runs`, `adapter_run_rows` (foreign key to its run, cascade) and
  `adapter_audit_events`, all with enabled and forced row security and a tenant
  policy. A partial unique index keeps one queued or running run per adapter.
  The background role reads `tenant_id, id, status, queued_at, lease_until` of
  queued and running runs and `tenant_id, adapter_id, enabled, next_run_at` of
  enabled scheduled bindings, nothing else.
- Source run. Every call starts from `input`; `paging` `cursor` writes the stored
  cursor at `param` and reads the next from `next`, `page` writes a page number
  from `start` and stops on an empty page, none reads one page. Records are the
  array at `items`. Each record is mapped, written through `import.write.v1` in
  batches of the port's `batchSize` with the registered mode, and ends as one
  `adapter_run_rows` row (index, natural key, outcome, code, field). Outcomes,
  counts and the next cursor commit in one transaction fenced by the claim token
  and `status = 'running'`.
- Sink run. The list comes from `exports.lists.v1` `find`, its permission is
  checked on the run's principal, each page is walked with the list's own
  `page` 200 rows at a time, the CSV records are read back into cells by column
  key, mapped, and pushed in batches of `batchSize` at the `items` path of `input`. The stored
  cursor is the row position, not the list's cursor: a list signs its cursors
  with a per process secret, so a reclaimed or resumed sink walks the list from
  its start and skips the rows before the position. Each push carries
  `adapters:<sha256(run chain, position of the first row)>:<slot>`.
- Job runner. Two runners of `createJobRunner`: `adapters.core.runs` (claim with a
  lease token, heartbeat renewing the lease under that token, `CLAIM_LOST` when it
  no longer matches) and `adapters.core.schedule` (no heartbeat; the compare and
  swap on `next_run_at` is the fence). A run that committed its last page before
  its process died settles without reading again.
- Retries. Three attempts per page, full jitter from 500 ms doubled and capped at
  5 s, `Retry-After` capped the same. Timeout, DNS, network, 5xx, 408, 429 and a
  call still in flight retry; the rest fail the run with the cursor kept.
  Resume queues a new run with trigger `resume`, the failed run's cursor and
  `resumed_from`, for the most recent run only.
- Scheduling. `next_run_at` on the binding, computed in the `system.core.timeZone`
  zone; a due binding queues a run as the account that last saved it, or appends
  `schedule-skipped` while a run is active; missed slots are skipped.
- Mapping as data: `rename`, `constant`, `format` (`trim`, `lower`, `upper`,
  `integer`, `decimal`, `boolean`, `iso-date`, `date:<layout>`), `lookup` through
  a table stored with the rule. A stored mapping is checked against the port's
  fields (every target a field, every required field written) or the list's
  columns. Dry run: the port's or the list's permission first, then the first
  page, at most 20 rows, `import.write.v1` validate, nothing written.
- Recorded mode: unbound adapter, a fixture, `NODE_ENV` not production. Exact
  input match first, then the first recorded input contained in the call input.
- Endpoints: `GET /api/adapters`, `GET /api/adapters/runs`,
  `GET /api/adapters/runs/:id`, `GET /api/adapters/runs/:id/rows` (read);
  `POST /api/adapters/bind`, `/dry-run`, `/runs/start`, `/runs/resume`,
  `/runs/cancel` (manage, CSRF first, bodies bounded, 40 KB for a binding). Run
  and row lists page with signed keyset cursors.
- Screen `data-adapters` (Administration, section integrations): the adapter
  table (adapter, direction, port or list, instance, schedule and switch, last
  run with counts), the configure drawer (instance picked from
  `/api/connectors/instances` filtered by the definition, the switch, declared,
  on demand or custom schedule, the mapping rule by rule against the port fields
  or list columns, lookup table, dry run preview) and the runs drawer (runs with
  Resume and Cancel, per-row outcomes). Loading, empty, error, populated and
  denied states, en and pl.
- Audit events `binding-saved`, `binding-enabled`, `binding-disabled`,
  `run-started` (manual and scheduled), `run-resumed`, `run-cancelled`,
  `schedule-skipped`. Meter `adapters.core.rows` per committed page. Data classes
  `run-rows` (30 days), `runs` (90 days), `bindings` and `audit` (kept), each
  exportable, erasure redacting the account and keeping the rows. Run list export
  `adapters.core.runs`.
- import.core 0.1.9: `import.write.v1` (`src/domain/write.ts`,
  `src/services/import-write.ts`) with `describe`, `validate` and `write`. The CSV
  job path is unchanged apart from exporting `shapeOf` and `exactKey`.
- exports.core 0.2.4: `exports.lists.v1` answers `find(id)`.
- auth.core 0.13.16: `adapters.runs.read` and `adapters.runs.manage` in the owner
  seed, migration `0035_adapters_scopes` granting both to existing owner
  memberships and built-in owner role rows, forced row security lifted around the
  insert and the role update and put back.
- `pnpm flowdular module enable adapters.core --apply`; the create-flowdular
  template lists the module with the same provides and requires (and
  `import.write.v1` on import.core); `scripts/sdk-members.json` packs it.
- `.ai/platform-capabilities.md`: Adapters paragraph, `import.write.v1` in Import,
  `find` in List export. `integration-adapter` skill sections 3 to 8 and the
  `adapters[]` lines of `module-new` now describe the registration, the stored
  mapping and the settled fixture matching instead of a module-owned run job.
  The CLI scaffold is unchanged: its stub shape is what the runtime reads.

## Where the contract did not match the tree

- The registration names in the contract have no input, no record path, no
  paging, no mode and no batch size, and neither has the spec section. The
  runtime needs them, so the registration gained `input`, `items`, `paging`,
  `mode` and `batchSize` (D-ADAPTERS-REGISTRATION-FIELDS).
- `import.ports.v1` only registers ports. Mapping validation and the dry run need
  the port's fields, so `import.write.v1` also has `describe` and `validate`, and
  `import.write.v1` joins `requires`. `import.ports.v1` and
  `connectors.instances.v1` stay declared as the contract lists them; no code
  resolves them.
- `exports.lists.v1` only registered lists, so a sink could not page one. It
  gained `find(id)`; the internal registry type omits it from the interface it
  extends.
- A list export signs its cursors with a secret created per process, so a list
  cursor cannot be persisted across a restart as the contract's "cursor persisted
  per page" suggests. A sink stores its row position instead and re-walks.
- The platform has no shared audit append, so the audit events live in a fourth
  table, `adapter_audit_events`, as connectors.core keeps its own trail.
- `automations.core` offers schedules only as rows an owner creates, so the
  scheduler is `next_run_at` on the binding with a runner of this module.
- The contract's run columns needed `queued_at` (a queued run has no start),
  `resumed_from` (the key scope of a resumed push) and a claim token in
  `claimed_by`.
- Owners of new and existing workspaces need the two scopes, which is an
  auth.core seed and migration change the contract did not list.
- No connectors change: the caller kind is `workflow`.
- The platform API snapshot did not change (no package surface moved), so it
  stays 0.1.18 rather than the expected 0.1.19.

## Decisions the contract left open

- The dry run also calls as `workflow`, not `test`: the binding accepts any
  instance id, and `test` would reach around the instance's consent.
- A run acts as its starter, a scheduled run as the account that last saved the
  binding, resolved live through `auth.core` `findTenantMember`; an inactive
  member fails the run with `ADAPTER_PRINCIPAL_UNAVAILABLE` and one without
  `adapters.runs.manage` with `ADAPTER_PRINCIPAL_FORBIDDEN`.
- Recorded mode is refused in production, so a fixture can never reach real
  records; enabling an unbound adapter there answers `ADAPTER_NOT_BOUND`.
- A binding starts disabled; a disabled adapter refuses start and resume and is
  never scheduled, while a dry run and a cancel still work; a queued run whose
  adapter was switched off fails with `ADAPTER_DISABLED`.
- A push slot the connectors ledger already bound to a failure, or to another
  input after a mapping change (`CALL_IDEMPOTENCY_CONFLICT`), is spent without
  counting an attempt, up to 32 slots, so a resume replays what the service
  accepted and retries what it refused.
- A sink counts a pushed row as created; the meter counts created and updated
  source rows and pushed sink rows.
- Import errors of a whole batch become `ADAPTER_PORT_FORBIDDEN`,
  `ADAPTER_TARGET_UNAVAILABLE` or `ADAPTER_PORT_FAILED`.
- A port id is split at each dot in turn until `describe` answers, since a module
  id carries dots of its own.
- Bounds: 1000 records per page, 1000 pages per run (resume continues), 64 rules,
  500 lookup entries, 2000 characters per value, 32 KB of mapping, 8 KB of input,
  1 MB of fixture, 5 minute lease, 2 s poll.
- The retry policy is copied from `modules/research/src/services/adapter-chain.ts`
  and `connector-failure.ts` (`src/services/retry.ts`), and the cron grammar from
  `modules/automations/src/domain/cron.ts` byte for byte, guarded by a test that
  compares the two files. Moving either would need a platform package.

## Verification

- adapters.core: `tsrx-tsc --noEmit`; 12 files and 53 tests on PGlite and the
  same 53 on the local PostgreSQL 17 cluster with the CI roles (NOSUPERUSER,
  NOBYPASSRLS): registry, mapping and building blocks, source runs (recorded
  paging and natural key repeat, crash takeover by a second runner with the
  stalled first process refused at commit, a run settled after its last commit,
  cancel, Retry-After, three attempts with the cursor kept and resume, a
  credential refusal not retried, consent, a revoked grant and a removed member,
  dry run), sink runs (pages and keys, a reclaimed push replayed from the ledger
  with list cursors signed by another process, resume under the first run's keys
  with the refused slot spent, a resume after the list pages differently, list
  permission, dry run), schedules (due, skipped while active, missed slots, zone,
  invalid cron), endpoints (401, 403, CSRF on every mutation, body bound, signed
  cursors, the owner flow), tenant boundary and background column grants,
  migrations fresh, adopted and mirrored, data classes, composition, translations
  and the client mapping editor. Every spec scenario names a test.
- Mutations, each restored and each failing at least one test: the page commit
  without the claim token, resume from the beginning, no consent check, resume
  under new keys, a replayed failure counted as an attempt, no active run guard,
  5xx not retried, no list permission check, no manage grant at run time, a
  required field left unwritten, a claim over a live lease, a sink ignoring its
  stored position, re-pushing rows before it, unstable push keys, and a reclaim
  after the last commit reading again. The claim token on the finish statement
  survives (the status guard covers every tested case).
- import.core 116 tests (new `write.test.ts`, 6) and exports.core 88 on PGlite and
  PostgreSQL 17; connectors.core 191; auth.core 337 on PGlite and its 20 migration
  tests on PostgreSQL 17, including `AUTH-ADAPTERS-SCOPES`; cli 28 files.
- Every `.tsrx` of the screen compiles with the octane compiler in both modes
  (the first pack showed the compiler refusing `@if` inside a module level column
  callback; those cells use expressions now).
- `pnpm verify`: rules, reference, capabilities, platform-api (0.1.18,
  unchanged) and typecheck pass; the test step stops at `packages/sandbox`,
  whose 12 `preview-worker` tests fail inside `.claude/worktrees` (known). A
  no-bail run of every workspace suite passes apart from those 12, including
  agents, automations, import, metering, users, workflows and platform after it.
  `pnpm validate` and `pnpm format:check` pass.
- `pnpm release:pack` packs `modules/adapters` into `@flowdular/sdk` (41 files,
  exports `./modules/adapters`, `/client`, `/server`, `/platform`) and
  `pnpm release:smoke` passes: the initialized application composes and serves
  with adapters.core. Nothing was published.

Spec hashes (sha256), under the owner's advance approval of spec changes:
adapters.core 0.1.0
`b8850a8d4b9e20e6b056d21311fd4dbcd371ea3f183f22fb0d38f4ffc050f411`, import.core
0.1.9 `87e68926e4eae3c816e0cf418960aa09eaf0ecf57ab2e03c1bee77144e05a3db`,
exports.core 0.2.4
`1b4409ff8524398b1de36a9f7eb1228043f57a0c21dc12f95fa2f351355de63d`, auth.core
0.13.16 `e05c1e93665bdb1295cf6f1c3932c2003810899f418070b447acbb0cc3e4a166`.

## Open points

- The sandbox preview does not compose `adapters.core` for a draft with adapters,
  so a session cannot run its recorded adapter in the preview yet.
- No module registers an adapter; the runtime is proven with a fake port, list
  and connector.
- A lookup against the target module's records needs a lookup on the import port
  contract.
- The finish statement's claim fence is covered only together with the status
  guard; no test separates them.
- A sink re-walk after a restart assumes the list keeps its order and page
  boundaries close to the first walk; a list whose rows moved in between can
  push a row twice or skip one.
- The screen was checked by typecheck, the client mapping test and the route
  tests, not in a running browser. The run and row tables use the current
  `Table` API and will move with the table cell redesign.
