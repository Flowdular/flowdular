# notifications.core (RFC 0002 G1) review, 2026-09-11

## Scope

First delivery under RFC 0002 in its proposed order. `notifications.core` 0.1.1
(spec v2, approved at hash
`f5472276c042e3d1aa87b46ac33ef3ec6f39d8ec64970728c0020e74da21aba4`): a
per-member inbox with preferences, outbound webhook subscriptions signed with
the inbound automations scheme, a delivery queue with claim, bounded retry,
dead letter, replay and retention, the public capability
`notifications.publish.v1`, the `notifications secrets-rotate` command, five
screens, a topbar unread widget and both locales. Publishers: `agents.core`
0.11.0 (hash `8e3cec386a9dc939d9c7b781117d17d6fdfcbff4bef7c4549ad44019a1ba4160`)
and `workflows.core` 0.5.0 (hash
`deb1135325f94b57009e0816150dcad886c9315651ac99a45365c4479f6b279e`) publish run
outcomes lazily and tolerate the module's absence. Member scopes through
`modules/auth` migration 0019, the module in the SDK member list and in the
generated application template, the `FD_NOTIFICATIONS_SECRET_KEY` wired into
backups, the generator, compose, Kubernetes, the build script and the docs.

## Procedure

Spec interview with seven owner decisions (scope, permissions, retention,
retry, sources, egress, no e-mail in v1) and twelve recorded defaults;
implementation from the approved spec in three phases (server, client,
publishers); five spec defects reported by the implementer and folded into
0.1.1 before the client phase; two read-only auto-reviews (server and ops,
client and publishers) with 23 findings, one blocker; an implementation pass
per area with a regression test per finding, proven to fail against the defect.

Findings that changed behaviour: the response drain runs inside the delivery
try so a stalled body is a `timeout` attempt instead of a halted loop; a held
attempt is parked by pushing `scheduled_for` so a paused backlog cannot own the
routing page; a delivery row is claimed (`sending`, `claimed_at`, migration 0008) before the request leaves and a stale claim is reclaimable; the dead
letter fan-out honours preferences; a losing concurrent publish returns the
winner's ids; the unread badge link carries the application path and the
workspace slug; the deliveries table fits the real workspace width; the
inbox drawer survives the row it mutated and every row has an open action;
provider error codes are pattern-guarded before they reach a notification;
the template composition is the exact `module sync` output.

## Commands and results

- Scoped: `module-notifications` 130 tests, `module-auth` 208, `module-agents`
  144, `module-workflows` 112, `create-flowdular` 43, `cli` scaffold suites
  green after the `files` declaration change, `migration verify` clean for 8
  notifications and 19 auth migrations, `module validate` and `spec validate`
  ok, capability card check ok.
- Repository: `pnpm verify`, `pnpm build`, `pnpm release:pack` and
  `pnpm release:smoke` are recorded in the session closing summary; the smoke
  proves a generated application installs, starts, builds and runs the
  standalone sandbox with the module in the packed SDK.

## Unresolved and remaining risks

- The spec warns `SPEC_ENTITY_UNIQUE_MISSING` on inbox, preference and
  delivery because their uniqueness is compound; accepted and recorded in the
  invariants.
- `sending` is a database-level lease, not a fifth public delivery state; a
  list filtered to `pending` omits a row for the in-flight window.
- A DNS record alternating between a public and a private address between the
  resolution check and the request is not defended beyond the re-check the
  spec requires.
- The webhooks table data columns still over-subscribe against the action
  column at narrow widths; the deliveries and inbox tables were rebudgeted.
- No test exercises a live customer endpoint outside 127.0.0.1; delivery tests
  run against a local HTTP server through an injected resolver.
- E-mail delivery of notifications, membership events as sources and a
  platform-level mail port are out of scope per the owner's decisions.

## Verdict

Pass for the reviewed scope, with the risks above recorded; the repository
gates named in the closing summary are the evidence.
