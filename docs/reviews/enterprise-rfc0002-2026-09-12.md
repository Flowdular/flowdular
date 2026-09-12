# RFC 0002 enterprise modules, delivery review record (2026-09-12)

Scope: the remaining RFC 0002 list after G1 (notifications) and G2 (auth
providers): directory.core (SCIM), audit.core (data classes, retention,
export, then sealing, legal holds, erasure), approvals.core with the
workflows human-approval node, documents.core on the storage port,
metering.core, import.core with the users members port, search.core with the
command palette, connectors.core with the harness consent gate, data class
declarations across every module, and the auth scope backfills that make the
new permissions reachable.

Every module was delivered spec first: interview, approved `spec/module.yaml`
(status approved under the owner's blanket approval for this delivery, every
edit reported with its hash), implementation with tests on the embedded
PostgreSQL provider, then the auto-review skill as a separate read-only phase.
Two review rounds ran, seven and six reviewers, and every finding returned to
implementation with a regression test proven to fail before the fix.

## Modules and specs

| Module             | Version | Spec hash (sha256, first 16) |
| ------------------ | ------- | ---------------------------- |
| agents.core        | 0.12.1  | `b6f493b704e958b6`           |
| approvals.core     | 0.1.5   | `01d18ee80916b642`           |
| audit.core         | 0.2.2   | `d88fb11a63e84473`           |
| auth.core          | 0.12.6  | `3cb5300b309e6951`           |
| automations.core   | 0.5.1   | `9da214defb1c17d8`           |
| connectors.core    | 0.1.3   | `df9df9016e2428c7`           |
| directory.core     | 0.1.4   | `bc3b64929fd52872`           |
| documents.core     | 0.1.4   | `b79b53cf27e97b38`           |
| import.core        | 0.1.3   | `5f93875f01ceb92f`           |
| metering.core      | 0.1.3   | `5af9dc3d49eb0d79`           |
| notifications.core | 0.1.5   | `b0eb91a5a58849cf`           |
| profile.core       | 1.5.1   | `9fdd1330b6349d8d`           |
| search.core        | 0.1.3   | `243474b4540446af`           |
| users.core         | 0.9.3   | `0e6e3b50f0065f3a`           |
| workflows.core     | 0.6.4   | `ff66c818081d09b9`           |

Full hashes: `shasum -a 256 modules/<dir>/spec/module.yaml`. sandbox.core and
system.core are unchanged.

## What landed

- Platform: data class registry on the server context with optional `sweep`,
  `export`, `erase` and `count` per class; policy seam; list pagination
  helpers; storage port with local and S3 adapters; platform API 0.1.1 with
  the surface widened to database, harness, cli-protocol, ui and client.
- Keys: `FD_CONNECTORS_SECRET_KEY` and `FD_AUDIT_ANCHOR_KEY` through the
  build, both env examples, both infra trees, the backup fingerprints and the
  deploy skill (`NODE_ENV=production` is the production switch).
- Auth: every enabled module's permissions are owner defaults, members hold
  what each spec decision grants (documents, search, connectors read,
  approvals read and decide, profile); backfills 0023 to 0027; passwordless
  member creation; bounded member lookups; keyset export indexes; erase on
  sessions and API tokens; a guard test that reads every enabled spec and
  fails when a permission is missing from the owner defaults.
- Egress: connectors and notifications dial only the addresses the policy
  verified, through `node:https` with a per-call agent; https is re-checked at
  call time; ports default to 443.
- Template: `flowdular.json` and the generated composition regenerated from
  the smoke consumer with the packed SDK (18 modules including the example).

## Review findings by round

Round one found, per area: connectors 3 high (member-reachable agent-call
route, caller-chosen run id, consent switch flipping both flags), approvals
and workflows 1 high (24 hour run window killing a parked approval), audit 3
blockers (erasure port registered too late, verify across workspaces, hash
preimage holes), import and users 3 high (CSV cell retention, claim lease
never renewed, resumed counters), metering and search 2 high (no paging,
every debounced prefix remembered), directory and documents 2 high (placeholder
password sometimes refused by auth, documents list cut at 200 rows), auth and
keys 3 high (holds scope missing from owners, keys absent from both infra
trees). All fixed.

Round two found: connectors 1 high (caller kind hardcoded to agent, so
workflow consent never applied), approvals and workflows 1 high (erasure
missed runs started on a person's behalf), audit 1 high (verify silent on a
deleted segment), directory 1 major (refusal budget blocking a valid SCIM
token without a trusted proxy), plus medium items on idempotency claim
timing, retake compare and swap, agents' hard dependency on metering, the
runs meter never checked, four audit tables outside the catalogue, the
approvals data class, quadratic export joins and palette error states. All
fixed, with the workflows subject column replacing the expression indexes
that PostgreSQL cannot use under forced row security.

## Gates

- `pnpm verify` (rules, reference, capabilities, platform API, typecheck,
  test, validate, format): green, 34 test packages, 3019 tests passed, 3
  skipped (the hosted PostgreSQL suites gated on an environment variable).
- `pnpm build`: green, including the platform bundle.
- `pnpm release:pack`: four public packages at 0.2.4 (sdk, cli), 0.2.6
  (generator) and 0.2.9 (sandbox).
- `pnpm release:smoke`: green after the template composition was regenerated
  from the smoke consumer (agents gained its metering requirement); the
  consumer scaffolds, installs, sets up, starts, verifies and builds with 18
  modules.
- `pnpm flowdular migration verify`: clean after the local database reset.

## Known follow-ups

- The developer's local PGlite database was recreated with `setup quick`
  after its ledger recorded auth `0023` from a copy broken for a minute during
  a credibility check; `migration verify` is clean and no deployment saw the
  bytes.
- `stash@{0}` from the approvals agent's mistaken `git stash` is still there
  as a backup of the pre-restore tree.
- Kernel: the registry's `removed` count is also used for redacted rows
  (approvals); a stricter reading needs a separate progress signal.
- auth display name search has no index (LIKE over the workspace); a trigram
  or prefix rule is the fix.
- workflows migrations 0006 and 0007 are superseded by 0008 and stay as dead
  weight because applied migrations are immutable.
- A palette hit still records no recall; the shell has no activation
  callback into a command search contribution.
- `modules/automations/src/server/workflow-tools.ts` still derives the caller
  kind from the actor; the tool context now carries it directly.
