# RFC 0004 platform services, first wave review record (2026-09-12)

Scope: the first wave RFC 0004 scheduled, in its order: H14 (follow-ups the
RFC 0002 reviews recorded), H2 (the job runner primitive and its adoption in
every module loop), H1 (the mail port and the notifications e-mail channel),
H3 (tenant time zone and cron schedules), H4 (list export through a new
`exports.core`), H13 (shared UI promotions), H5 (workspace reports through a
new `reports.core`), H6 (access review through a new `access.core`), H7
(tracing, module metrics, error reporting), H8 (feature flags on module
settings) and the H12 residency documentation.

Every module change was delivered under the owner's blanket approval for
this delivery: spec edits keep `status: approved` and every hash is listed
below. Implementation ran as parallel streams with disjoint file ownership,
then seven read-only reviewers covered the wave and every finding returned
to implementation with a regression test proven to fail before the fix.

## Modules and specs after the wave

| Module             | Version | Spec hash (sha256, first 16) |
| ------------------ | ------- | ---------------------------- |
| access.core        | 0.1.1   | `382fdc84b7681276`           |
| agents.core        | 0.12.6  | `b143e3ada6e07904`           |
| approvals.core     | 0.1.10  | `ed7e3a8c1fa26173`           |
| audit.core         | 0.2.7   | `fe051321f1d0c1b7`           |
| auth.core          | 0.13.6  | `2c20bf7bed128278`           |
| automations.core   | 0.6.4   | `82ac412cddb7c6ce`           |
| connectors.core    | 0.1.3   | `21936e6fdcfad94e`           |
| directory.core     | 0.1.6   | `a4002a231c7130e9`           |
| documents.core     | 0.1.6   | `c584702b29d47f1f`           |
| exports.core       | 0.2.1   | `7cb25f31c5b072dd`           |
| import.core        | 0.1.7   | `1561806580c0e080`           |
| metering.core      | 0.1.6   | `ee9b925fac7ce4e4`           |
| notifications.core | 0.2.5   | `5f7538caa9cf45b8`           |
| profile.core       | 1.5.1   | `4a54bb8e67be87e2`           |
| reports.core       | 0.1.2   | `ac71cd0873b82d6d`           |
| search.core        | 0.1.4   | `2f7d3d3cc5229fb6`           |
| system.core        | 0.7.2   | `a491099f23d2b75f`           |
| users.core         | 0.9.6   | `d0957eb0a591c8c1`           |
| workflows.core     | 0.6.4   | `cc7baa0b958a4a60`           |

Platform API 0.1.3 (`packages/kernel/platform-api.snapshot.d.ts`); twenty
modules enabled; the template composition regenerated from the smoke
consumer with the packed SDK.

## What landed

- Job runner (`createJobRunner` in `packages/server/src/jobs`): claim,
  perform and heartbeat with a `CLAIM_LOST` fence, bounded batches,
  concurrency, backoff, per-item isolation, `wake()` for a follow-up pass,
  idle passes silent for the trace sink; adopted by import, audit (three
  loops), approvals, automations, notifications (delivery and retention),
  auth (a bounded session sweep) and agents action execution.
- Mail port on the server context (`context.mail`): `none`, `development`
  and `smtp` adapters, bounds and header hygiene, `FD_MAIL_*` with the auth
  names as a deprecated fallback; auth is the first sender; notifications
  gained an e-mail channel per member preference with the webhook ledger,
  retry and dead letter, and a permanent rejection dead-letters at once.
- Tenant time zone (`system.core`, `TENANT_TIME_ZONE_SETTING` in contracts)
  and cron expressions beside `every:N` in automations, next run in the
  tenant zone with DST handled through `Intl`, re-timing on a zone change.
- List export: `defineListExport` and `runListExport` in `packages/server`,
  `exports.core` with a catalogue, a start control, jobs on the runner,
  files through the storage port, a 30 day data class; first registrations
  in users (members) and access (review, attestations).
- Shared UI: `FileUpload`, `DatePicker`, `Select.autoFocus`, focus trap and
  restore in `Drawer` and `ConfirmDialog`, `TableAction.reason`, `Table`
  server mode, `Pagination` keyset branch; `workspaceViewHref` promoted to
  `@flowdular/client/routing`.
- Reports: `reports.v1` providers with a time budget and a cancellation
  signal, `reports.core` screen and dashboard widget, providers in metering
  (calendar month) and agents (runs per day), translated labels.
- Access review: `access.core` with a point-in-time review, a diff and an
  activity report over the auth trail window, append-only attestations; auth
  gained the read surfaces (audit window, external identities, paged
  members) and owner scopes for reports, exports and access (backfill 0029)
  with a keyset index (0030).
- Observability: W3C `traceparent` on every endpoint, spans in the runner
  and the harness, OTLP/HTTP JSON exporter with shutdown drain, module
  metrics on `context.metrics`, an error sink, `context.tracer`; the import
  job resumes the trace that enqueued it.
- Feature flags: `kind: 'flag'` on tenant-scoped module settings, audited
  as `settings.flag.changed` with previous and next values, a Flags tab.
- H14: auth member search on prefix indexes (0028), users search pushdown in
  query order, kernel `redacted` on erasure results, palette hit recall,
  automations caller kind from the tool context.

## Review findings by area

- Runner: 2 high (a kick joined the in-flight pass and waited an interval;
  restart while a pass ran leaked scheduling chains), 3 medium (one
  renewal per lease, no backoff on any adopter, idle passes filling the span
  ring), 4 low. Fixed.
- Mail: 3 medium (a rejecting SMTP factory escaped the `MailError` contract,
  the e-mail switch was live before the preferences loaded, a title with a
  line break burned the whole retry budget), 6 low. Fixed.
- Cron and flags: 1 medium (unbounded time zone acceptance cache under
  case variants), 7 low including the Vixie day rule. Fixed.
- Exports and access: 3 major (an object orphaned when the settle failed,
  the review export cut at the 500 member cap without a trace in the file,
  no way to start any export but members), 3 medium, 4 low. Fixed.
- Reports: 4 medium (the error state removed the filter, untranslated
  provider labels, a false range caption for the calendar month provider, a
  time budget that cancelled nothing), 6 low. Fixed.
- Observability: 3 medium (the stored trace parent was never resumed, the
  exports runner had no trace sink, shutdown dropped buffered spans), 4 low.
  Fixed.
- UI and H14: 3 medium (calendar cursor onto disabled days, a keyset
  walk-back during a refresh, refusals folded into action labels), 6 low.
  Fixed.

## Gates

Final run on 2026-09-12 after the last fix (the exports composition read the
storage configuration under the build's production `NODE_ENV` and refused the
local adapter; the ceiling now falls back to the storage default there):

- Typecheck, `spec validate --all` and `migration verify`: exit 0.
- `pnpm verify`: exit 0, 429 test files, 3665 tests passed, 3 skipped (the
  hosted PostgreSQL suite without a server).
- `pnpm build`: exit 0.
- `pnpm release:pack`: exit 0, four public packages.
- `pnpm release:smoke`: exit 0, the consumer with 21 modules created,
  installed, set up, started, verified and built; its regenerated composition
  is byte-identical to the template.

## Incidents

- One implementation agent ran a scoped `git stash push` and `pop` on the
  system and automations paths and restored the tree; verified clean.
- One fix agent ran `git checkout` on the auth repository file and
  reconstructed the five uncommitted pieces from their interfaces and tests;
  the full auth suite (319 tests) and the consumers typecheck against it.
  About a dozen lines of comment prose may differ from the lost copy.

## Follow-ups recorded by the reviews

- A `jobBackoff(intervalMs)` helper in `@flowdular/server` to replace the
  seven copies of the backoff literal.
- The auth templates stay English; selecting mail wording by the
  recipient's locale is an auth follow-up (spec outOfScope).
- The palette focus trap and `packages/ui` `focus-trap.ts` could share one
  implementation.
- The exports catalogue endpoint opens the repository for a registry read.
- SAML (H11), PDF (H10) and the outbox (H9) stay deferred per RFC 0004.
