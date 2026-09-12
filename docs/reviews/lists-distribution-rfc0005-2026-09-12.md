# RFC 0005 first wave review record (2026-09-12)

Scope: the wave the owner accepted on 2026-09-12: I1 (official modules on
the current core), I4 with the small I6 items (review follow-ups and the
open audit items), I2 (server-side lists), I3 (selection and bulk actions),
I7 (documentation) at any point. This record grows with the wave.

## I1: official modules against the current core

Delivered in `Flowdular/official-modules` pull request #1 (branch
`feat/core-0.2-compat`, commits `d7544e8` and `b8281b3`), tested against the
SDK packed from this tree at `flowdular` 0.2.4, `@flowdular/sdk` 0.2.4,
`create-flowdular` 0.2.6.

| Module        | Version | Spec hash (sha256, first 16) |
| ------------- | ------- | ---------------------------- |
| catalog.core  | 0.7.0   | `ec931c78f351c7fc`           |
| expenses.core | 0.7.0   | `5d212d7c59e75e41`           |
| parties.core  | 0.9.0   | `7fb80fd6d926c167`           |

- Ranges: `system.core ^0.7.0`, `auth.core ^0.13.0`, `platformApi ^0.1.0`
  in module.json and spec; the kernel refused the previous exact pins.
- Data classes: items, claims and parties with their history are exported
  per tenant in bounded keyset pages inside the module's own transaction; no
  class is swept or erased; the idempotency ledgers of catalog and parties are
  excluded from the export with a stated reason because the approved specs
  call them durable replay evidence. Spec bullets added under `invariants`
  and `dataOwnership` under the owner's blanket approval; schemaVersion 1 is
  still accepted by the validator.
- Review records carry the new source digests; `release:pack --local`
  produced the three release artifacts and the local index.
- Gates in the official repository against the packed SDK: rules, typecheck,
  tests (expenses 54, catalog 35, parties 68, consumer 3), `module validate`,
  prettier.
- Acceptance in a fresh consumer app created by the SDK smoke (21 core
  modules): `module install` of the three releases from the local index,
  `module enable`, `module validate`, the app's `verify` (168 official module
  tests) and `build`, all exit 0.
- In this tree: `.ai/references/catalog` regenerated from the 0.7.0 artifact
  by `scripts/module-reference.mjs` (provenance pinned to `b8281b3`),
  `docs/module-distribution.md` names platform API 0.1.3.

Open: the official lockfile still resolves the 0.1.0 SDK, so its CI stays
red on `--frozen-lockfile` until the 0.2.4 packages are on npm and the
lockfile is regenerated; the owner deferred that publication. The first
commit's hunk split put a few data class spec bullets next to the version
changes; the content is right, the split is not clean.

One lesson repeated: a YAML scalar in a spec bullet with `: ` inside parses
as a mapping and fails the schema; three agents wrote such bullets and the
packer refused the release until they were rephrased.

## I4, the small I6 items and I7

Delivered on the branch `feat/rfc0005-wave-1` from the tip of PR #1, as six
implementation streams with disjoint file ownership, five read-only
reviewers, and one fix round.

### Modules and specs after the wave

| Module             | Version | Spec hash (sha256, first 16) |
| ------------------ | ------- | ---------------------------- |
| agents.core        | 0.12.7  | `ededcf30f1a8fb65`           |
| approvals.core     | 0.1.11  | `a2797df05a5b720b`           |
| audit.core         | 0.2.8   | `50eb919903883b0d`           |
| auth.core          | 0.13.8  | `82d3a94dada36ab1`           |
| automations.core   | 0.6.5   | `5472af2098e21f8a`           |
| connectors.core    | 0.1.4   | `91ed663a1de1aa30`           |
| directory.core     | 0.1.7   | `97e2b794537c0f06`           |
| exports.core       | 0.2.2   | `b3d5e511f4be3c46`           |
| import.core        | 0.1.8   | `f1bfc26390eab170`           |
| metering.core      | 0.1.7   | `ccd7feab441e78a7`           |
| notifications.core | 0.2.6   | `387766da0255301e`           |
| profile.core       | 1.5.2   | `47ee226e825a1e45`           |
| sandbox.core       | 0.4.1   | `e642d1d46fd22de6`           |
| search.core        | 0.1.5   | `23bb292f29293a09`           |
| workflows.core     | 0.6.6   | `27c2cbaa2a0ecd07`           |

Platform API 0.1.4 (`jobBackoff`, `integer`, `trapFocus`,
`focusableElements`). Only the auth spec changed in content (the mail locale
rule and the actor kinds); every other bump is a patch for a source change
under the same spec.

### What landed

- I4a: `jobBackoff(intervalMs)` in `@flowdular/server` replaces the eight
  copies of the backoff literal.
- I4b: auth mail wording comes from the translations bundle of the
  workspace's `defaultLocale` setting (`en` fallback, `pl` written), the
  spec outOfScope narrowed to per-workspace custom phrasing.
- I4c: `trapFocus` and `focusableElements` exported from `@flowdular/ui` and
  adopted by the command palette, which restores the opener on close. The
  palette's results list had never rendered in a browser: its keyed loop
  iterated an `entries()` iterator the runtime cannot index; it renders now.
- I4d: the exports catalogue answers from the sealed list registry without a
  database lease.
- I6 #7: audit write failures in auth count on `audit_write_failures_total`
  and reach the error sink without driver detail; the platform and template
  compositions pass `createModuleMetrics('auth.core')`.
- I6 #8: auth 0032 admits the `service` actor kind with a
  `configured_by_json` column; operators and identity providers are recorded
  as service actors.
- I6 #10: automations 0003 and 0004 adoption probes check the index, the
  background policy row and the column grant, and report partial adoption.
- I6 #14: the agents preflight reads the module agent catalogue on a runtime
  lease under the sentinel tenant, never a migration lease.
- I6 #15: `setup migrate-state` copies the key files only and warns per
  SQLite database file it leaves in place.
- I6 #19: workflows has a request harness and an authenticated 2xx test per
  write route plus a CSRF mismatch refusal.
- I6 #20: the sandbox directory reads member scopes in one auth call.
- I6 #22: one `integer(value, field, { min? })` decoder in
  `@flowdular/database` replaces the seventeen repository copies and the two
  template copies, each site keeping its strictness.
- The agents worker classifies an event write refused on a run it no longer
  holds as a lost lease (the CI race), classifies once and drains before
  release.
- I7: blueprint section 14 describes the agent layer that shipped;
  `docs/sandbox.md` documents the `git-pr` delivery target; the policy files
  and `.ai/README.md` name what reads them.

### Review findings

- Jobs and decoder: 3 low (template copies, the API bump covering more than
  two additions, the agents decoder tightening). Fixed or recorded.
- Auth: 2 medium (no composition passed `metrics` to the auth runtime, no
  runtime-level locale test), 2 low (configuredBy and settings audit paths
  untested). Fixed.
- UI, exports, sandbox: 1 low (jsdom devDependency). Fixed.
- Automations, workflows, agents, CLI: 1 high (an untracked harness file,
  staged), 1 medium (the asynchronous classification could lose the race
  with the run's own failure path), 3 low. Fixed; the `.db` warning now
  covers any database file.
- Documentation: 1 high, 1 medium, 3 low on claims the code did not back
  (`requireReviewer` location, the compare link, the dependency budget).
  Fixed.

### Gates

Final run on 2026-09-12 after the fix round:

- Typecheck, `migration verify`, `capabilities:check` (49 UI exports),
  `platform-api:check` (0.1.4), `reference:check`: exit 0.
- `pnpm verify`: exit 0, 431 test files, 3694 tests passed, 3 skipped (the
  hosted PostgreSQL suite without a server).
- The CI adapter matrix (database-testing, auth, agents, profile, sandbox,
  automations, workflows) on a local PostgreSQL 17 with the CI roles: all
  green; the agents recovery suite four times in a row.
- `pnpm build`, `pnpm release:pack`: exit 0.
- `pnpm release:smoke` with `claude` and `codex` hidden from `PATH`: exit 0,
  the consumer's regenerated composition byte-identical to the template.

### Follow-ups

- `module version bump` does not rewrite a quoted `specVersion` scalar
  (profile); aligned by hand.
- The scaffold still emits a private `whole()` decoder for integer fields.
- The audit items #11, #12, #13 and #18 stay open as RFC 0005 recorded.
