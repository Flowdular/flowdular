# RFC 0004: Platform services and the remaining readiness gaps

- Status: accepted by the owner on 2026-09-12; the first wave is H14, H2, H1, H3, H4, H13, H5, H6, H7 and H8 in the proposed order; H11 (SAML) waits for a buyer, H10 (PDF) waits for a business module naming the document, H9 (outbox) follows H2 when a second module needs decoupling, H12 (residency) is documentation
- Date: 2026-09-12
- Follows: RFC 0001 (enterprise readiness), RFC 0002 (enterprise modules,
  delivered on 2026-09-12, see `docs/reviews/enterprise-rfc0002-2026-09-12.md`)
- Relates to: ADR 0003 (module settings), ADR 0004 (enterprise access and
  audit), ADR 0006 (agentic workflows), ADR 0008 (database adapter contract)

## Why this document exists

RFC 0002 delivered the modules a business asks for by name. What is left is
quieter: the services every module reaches for and rebuilds on its own, the
two RFC 0001 gaps that were never scheduled, and the honest list of what the
capability card still marks as absent. This document reads the tree as it is
on the date above, states a verdict per gap, and proposes an order. Nothing in
it is scheduled until the owner accepts it.

The verdicts follow RFC 0002: **module** (its own tables, permissions,
screens, an approved spec), **platform capability** (a seam in `packages/*`
or `platform/*` that modules compose against) or **documentation** (a
position to state, not code to write).

## What exists today, read out of the tree

- Outbound mail: `modules/auth` owns the only transport (`none`,
  `development`, `smtp`, `modules/auth/src/server/runtime.ts:312`). A module
  cannot send mail; `notifications.core` delivers in-app items and signed
  webhooks only.
- Background work: seven modules run their own poll loop on `setInterval`
  with a lease, a claim statement, a heartbeat and a quiesce hook (agents
  action execution, approvals expiry, audit sweep and export and erasure,
  auth, automations, import, notifications delivery), plus the workflows
  worker. The shapes converged during RFC 0002 (claim with a stale window,
  heartbeat per batch, `inFlight` guard, drain on stop) but every module
  carries its own copy.
- Schedules: `automations.core` accepts `every:N` whole minutes only
  (`modules/automations/src/domain/cadence.ts`), evaluated without a tenant
  time zone; no tenant declares a time zone anywhere.
- Lists: every new list endpoint pages with the keyset helpers in
  `packages/server/src/pagination.ts`; the older lists (users, agents,
  workflows, automations) still load whole sets. `Table` sorts and pages the
  rows it is given, client-side.
- Export: `audit.core` exports a whole workspace as an archive; no list has
  a CSV export of its own and no screen has a bulk action over a selection.
- Reporting: the read model pattern is written down in RFC 0002 G5 and
  followed by `agent_run_costs` and the metering buckets; there is no
  composition of per-module rollups for a workspace report.
- Observability: request metrics on `/api/metrics`, a JSON logger with the
  request id; no tracing, no module-owned metrics, no error reporting sink.
- Identity: password, tenant-owned OIDC providers, SCIM provisioning; no
  SAML, no LDAP.
- Documents: uploads, attachments, filters and paging; no rendering of any
  kind.
- Feature flags: none. Module settings (ADR 0003) are the nearest thing and
  are not audited as flags.
- Access review and residency: RFC 0001 G8 and G9 remain open; every other
  RFC 0001 gap was closed by RFC 0002 (backup, retention, archival, hold,
  export, erasure, key rotation).

## Gaps

### H1. Mail as a platform capability

**Verdict: platform capability, then a notifications channel.**

Move the transport auth.core already configures onto the server context as a
mail port (`context.mail`), keep auth as the first sender, add a bounded
template contract (subject, text, optional HTML, locale) and let
`notifications.core` deliver inbox items by mail per member preference. A
module never talks to SMTP; it publishes a notification.

Extends: `packages/server` composition, `notifications.core` preferences and
delivery ledger. Depends on: nothing. Risk: mail is the one egress with no
allowlist; the port must keep the auth transport's refusal of the
development sender in production.

### H2. A durable job runner primitive

**Verdict: platform capability, extracted from the seven copies.**

One helper in `packages/server` that owns the loop: a claim statement over a
routing table the module still owns, a lease with heartbeat, a stale window,
bounded batches, backoff, the `inFlight` guard and the drain on stop. Modules
keep their tables and their SQL; they hand the runner a `claim`, a `perform`
and a `heartbeat`. The three review findings on claims (import lease never
renewed, connectors retake without compare and swap, audit erasure claim
expiry) are the argument: the same bug was found three times in three copies.

Extends: `packages/server`. Depends on: nothing. Risk: a migration of seven
modules is a large diff; the runner has to be adopted one module at a time
behind the existing tests.

### H3. Schedules with cron and a tenant time zone

**Verdict: extend `automations.core`, plus one tenant setting.**

A tenant time zone setting in `system.core` (IANA name, validated), a cron
expression alongside `every:N` (five fields, no seconds, bounded), next-run
computed in the tenant zone, missed slots still skipped and never replayed.
Depends on: H2 helps but is not required.

### H4. List export and bulk actions

**Verdict: platform capability plus a `Table` mode.**

A CSV export for any list endpoint that already pages with the keyset
helpers: the endpoint declares the columns, the platform streams the pages
into one file through the storage port and hands back a read URL, bounded by
rows and bytes, recorded in the module's audit trail. A `Table` selection
model with a bulk action slot the module wires to its own endpoint, bounded
to the visible page. Depends on: the storage port (exists), H2 for the
export job.

### H5. Workspace reporting through the registry

**Verdict: platform capability, the second half of RFC 0002 G5.**

A `reports.v1` contract a module registers (key, label, permission, a
`read(tenantId, range)` over its own rollup), composed by a small
`reports.core` screen that asks every provider and renders the tiles, the
way search composes providers. No cross-module SQL, no second role. Depends
on: nothing hard; metering and agents already hold rollups.

### H6. Access review and administrative activity reporting (RFC 0001 G8)

**Verdict: module, `access.core` as ADR 0004 named it.**

A point-in-time listing of who holds what (memberships, roles, scopes, API
tokens, identity bindings), a diff between two dates from the auth audit
trail, an administrative activity report filtered to privileged actions, and
a recorded attestation that someone reviewed it, with export through H4.
Depends on: auth read surfaces (exist), H4 for the export.

### H7. Observability: tracing, module metrics, error reporting

**Verdict: platform capability.**

A trace context carried from the request through the job runner (W3C
`traceparent`), spans around endpoints, jobs and provider calls, an optional
OpenTelemetry exporter, a `context.metrics` for module-owned counters and
histograms with the same label bound the request metrics have, and an error
reporting sink behind the logger. Depends on: H2 for the job spans.

### H8. Feature flags

**Verdict: platform capability on module settings.**

A flag is a boolean module setting with a declared default, an audit event on
every change, a per-workspace override and a read that is cheap on the request
path. Nothing more: no percentage rollouts, no targeting. Depends on: ADR
0003 settings (exist).

### H9. Event bus

**Verdict: platform capability after H2, as an outbox.**

Modules integrate synchronously through the capability registry today, which
is the right default. The cases that need decoupling (a document uploaded, a
member deprovisioned, a run settled) are served by an outbox row written in
the owner's transaction and drained by the job runner to subscribers that
registered a handler at composition. Not a broker. Depends on: H2.

### H10. PDF generation

**Verdict: module on documents.core, bounded, or deferred.**

A renderer that turns a declared template plus a record into a PDF stored
through documents.core, run as a job, with a page and byte bound. The
renderer is the risk: a browser engine in the image is heavy, a pure
TypeScript renderer is limited. Deferred unless a business module names the
document it needs.

### H11. SAML

**Verdict: extend `auth.core` as a provider kind; LDAP refused.**

SAML 2.0 SP-initiated sign-in as a second provider kind next to OIDC,
tenant-owned like the OIDC providers, with the same subject binding and JIT
rules. LDAP is refused: it is a directory protocol, and directory
provisioning is SCIM. Depends on: nothing.

### H12. Data residency (RFC 0001 G9)

**Verdict: documentation.**

State the position: one deployment, one region, one database; a tenant with
a residency requirement gets its own deployment. Record what per-tenant
routing would cost so the decision stays deliberate.

### H13. Shared UI promotions from the reviews

**Verdict: `packages/ui`.**

`FileUpload` promoted from documents.core, a calendar picker with presets,
`Select` with `autoFocus`, focus trap and restore in `Drawer` and
`ConfirmDialog`, a `TableAction` reason field for disabled actions, a server
mode for `Table` (H4). Depends on: nothing.

### H14. Technical follow-ups recorded by the RFC 0002 reviews

**Verdict: small, do them first.**

An index for member search by display name in auth; the kernel registry's
`removed` count versus redacted rows; the palette hit recall; the
automations caller kind read from the tool context; the `workflows`
migrations 0006 and 0007 left in place as superseded.

## Proposed order

1. **H14, the follow-ups.** Small, already specified by the reviews.
2. **H2, the job runner.** Everything after it either uses it or is cheaper
   with it, and it retires a bug class found three times.
3. **H1, mail.** The last outbound channel a module cannot use.
4. **H3, schedules.** The oldest documented gap on the capability card.
5. **H4 and H13, export, bulk actions and the UI promotions.** The pieces a
   business module asks for on its first list screen.
6. **H5 and H6, reporting and access review.** Both read what exists.
7. **H7, observability.** Once the job runner carries a trace context.
8. **H8, flags.** Cheap, independent.
9. **H11, SAML.** When a buyer asks; the OIDC path already covers most.
10. **H9, the outbox.** When a second module needs decoupling.
11. **H10, PDF.** When a business module names the document.
12. **H12, residency.** Documentation, can land any time.

## Decisions recorded on 2026-09-12

- First wave: H14, H2, H1, H3, then H4 with H13, then H5 with H6, then H7
  and H8, in the order proposed above.
- The mail port lives on the server context (`context.mail`); auth.core is
  the first sender and notifications.core gains an e-mail channel per member
  preference.
- SAML (H11) is scheduled when a buyer asks for it; the OIDC providers and
  SCIM cover the current demand.
- PDF (H10) is deferred until a business module names the document it needs.
- The outbox (H9) follows the job runner when a second module needs
  decoupling; residency (H12) lands as documentation at any point.

## Open questions for the owner, as they stood before the decisions

- Which gaps form the first wave, and is the order above acceptable.
- Does the mail port live on the server context (H1) with auth as one sender,
  or does auth keep owning mail and expose a capability.
- Is SAML wanted before a buyer asks for it.
- Is PDF deferred until a business module names the document it needs.
