---
title: Security Risk Management
subtitle: The method, the register and the treatment plan for security risk in the Flowdular platform and the agentic delivery process that builds on it.
eyebrow: Security Handbook
docId: FD-SEC-001
version: 0.1
status: Draft for review
owner: Platform Engineering
approver: Unassigned
audience: Engineering, security review, prospective customers under NDA
date: 2026-09-22
nextReview: 2026-12-22
classification: Restricted
---

## Purpose and scope

This document states how security risk is identified, scored, treated and
reviewed for the Flowdular platform, the modules delivered on it and the agentic
process that authors those modules.

In scope: the platform runtime, the module system, tenant isolation, key
material, the object store, the audit chain, the sandbox in which coding agents
work, and the delivery pipeline that lands their output.

Out of scope: the security posture of a customer's own deployment infrastructure
(network, host hardening, identity provider), which is governed by that
customer's controls and referenced here only where the platform depends on it.

> [!warning] This is a draft
> The register below is complete as an inventory, but ownership and target dates
> are unassigned. Filling those in is the first task of the review that accepts
> this document. Nothing here should be quoted externally until it carries an
> approver.

<!-- page -->

## Method

### Scoring

Each risk is scored on likelihood and impact, one to five, and the product
places it in a band.

| Band     | Score    | Meaning                                                     |
| -------- | -------- | ----------------------------------------------------------- |
| Low      | 1 to 4   | Accept and monitor                                          |
| Moderate | 5 to 9   | Treat within the normal roadmap                             |
| High     | 10 to 14 | Treat before the next release that touches the area         |
| Critical | 15 to 25 | Stop and treat; no release ships with an untreated critical |

Likelihood is judged against the platform as it stands today, with the controls
already in place. A risk whose control is a rule rather than a mechanism is
scored as if the rule will eventually be broken, because it will.

### Risk appetite

The platform accepts no residual risk in three areas: cross-tenant data
exposure, unauthenticated access to tenant data, and irreversible loss of
customer data. Everything else is negotiable against delivery cost, and the
negotiation is recorded in the register.

### Roles

| Role          | Responsibility                                                 |
| ------------- | -------------------------------------------------------------- |
| Risk owner    | Accepts the score, owns the treatment, reports at review       |
| Platform lead | Approves treatment that changes a platform invariant           |
| Reviewer      | Verifies that a control is a mechanism, not a stated intention |
| Approver      | Signs the register each cycle                                  |

### Cadence

The register is reviewed quarterly, and out of cycle whenever a new module class
ships, a platform invariant changes, or an incident closes. A risk whose score
changes is re-scored in the register with the reason, not silently edited.

<!-- page -->

## Trust boundaries

Five boundaries carry the platform's security weight. Every risk in the register
sits on one of them.

1. **Request to principal.** Identity comes from the authenticated session and
   never from request input. Tenant identity is derived from the principal.
2. **Principal to data.** Row-level security is forced on every tenant table
   with both `USING` and `WITH CHECK`, and queries run inside a transaction
   bound to a tenant id and an access level.
3. **Module to module.** Cross-module access uses declared public capabilities
   or registered tools. One module never reads another's tables.
4. **Agent to platform.** An agent's instructions cannot expand its permissions
   or its tool grants. The ceiling is declared outside the prompt.
5. **Sandbox to host.** A sandbox agent has no network, no git and no database
   outside its own module's tests.

## Controls in place

These are mechanisms enforced by the runtime or a gate, not conventions.

- Endpoints are declared through `defineEndpoint` with an explicit permission
  and identity resolver. There is no implicit public endpoint.
- Mutations enforce CSRF and bounded input validation.
- Runtime database roles hold neither `SUPERUSER` nor `BYPASSRLS`; production
  refuses a boot that violates this. Migration leases are for DDL only.
- Applied migrations are immutable and checksum verified. A changed applied
  migration fails adoption rather than running.
- Every stored object is encrypted with AES-256-GCM, its metadata authenticated
  with it, and keyed by `<tenantId>/<moduleId>/<objectId>`. An object moved to
  another tenant's prefix does not decrypt.
- Audit segments are sealed and anchored with a signing key held by the
  deployment, so a segment cannot be rewritten by whoever holds the database.
- Credentials never appear in output, logs or audit records.
- Production refuses generated keys, the embedded database, the local object
  store, a development mail transport and TLS weaker than `verify-full`.
- Tenant isolation is proven by tests that run against real PostgreSQL in CI,
  under roles that cannot bypass row-level security.

<!-- page -->

## Risk register

Likelihood (L) and impact (I) are one to five. Score is their product.

| ID   | Risk                                                                  | L   | I   | Score | Band     |
| ---- | --------------------------------------------------------------------- | --- | --- | ----- | -------- |
| R-01 | A module query omits the tenant predicate and reads across tenants    | 2   | 5   | 10    | High     |
| R-02 | A runtime role is granted `BYPASSRLS` during an incident and kept     | 2   | 5   | 10    | High     |
| R-03 | An encryption key is lost without a backup                            | 2   | 5   | 10    | High     |
| R-04 | Agent-authored code widens a permission boundary unnoticed            | 3   | 4   | 12    | High     |
| R-05 | Prompt injection via tenant content reaches an agent holding tools    | 3   | 4   | 12    | High     |
| R-06 | A dependency introduced during agent work carries a known advisory    | 3   | 3   | 9     | Moderate |
| R-07 | An applied migration is edited and the checksum gate is bypassed      | 1   | 5   | 5     | Moderate |
| R-08 | A credential reaches a log line or an audit record                    | 2   | 4   | 8     | Moderate |
| R-09 | An uploaded object carries malware; scanning is a seam, not a default | 3   | 3   | 9     | Moderate |
| R-10 | Session or MFA compromise of an owner account                         | 2   | 5   | 10    | High     |
| R-11 | An audit segment gap goes unnoticed between anchor checks             | 2   | 3   | 6     | Moderate |
| R-12 | A sink connector exfiltrates tenant data to an attacker endpoint      | 2   | 4   | 8     | Moderate |
| R-13 | Unbounded input exhausts a pool, a statement timeout or memory        | 3   | 3   | 9     | Moderate |
| R-14 | A sandbox agent reaches the network or a database outside its tests   | 1   | 5   | 5     | Moderate |
| R-15 | A generated migration drops or rewrites customer data                 | 2   | 5   | 10    | High     |

### Notes on the highest entries

**R-04 and R-05 are the risks the agentic process adds.** Everything else on
this register exists in a hand-written platform too. These two do not, and they
are the reason this document exists as its own artifact rather than a section in
the operations handbook.

R-04 is contained by declaring the permission ceiling outside the prompt and by
a review phase that runs after implementation and reports rather than fixes. It
is not contained by asking the agent to be careful.

R-05 has no complete control today. Tenant content is untrusted input, and an
agent that reads it while holding tools is a confused deputy. The current
posture is the tool ceiling: an injected instruction can only reach what the
grant already allowed.

<!-- page -->

## Treatment plan

| ID   | Treatment                                                                   | Owner      | Target |
| ---- | --------------------------------------------------------------------------- | ---------- | ------ |
| R-01 | Keep the isolation suite as a merge gate; extend it to every new table      | Unassigned | TBD    |
| R-02 | Alert on a role grant change; re-assert role attributes at every boot       | Unassigned | TBD    |
| R-03 | Document key backup as a bring-up step; verify restore once per cycle       | Unassigned | TBD    |
| R-04 | Evaluation suite for the implementation skills, with permission assertions  | Unassigned | TBD    |
| R-05 | Separate the agent that reads tenant content from the one that holds tools  | Unassigned | TBD    |
| R-06 | `pnpm audit --prod --audit-level high` stays a merge gate                   | Unassigned | TBD    |
| R-07 | No treatment; the gate is sufficient and the risk is acceptance of bypass   | Unassigned | TBD    |
| R-08 | Redaction test on the log and audit writers, with a deliberate secret       | Unassigned | TBD    |
| R-09 | Decide whether a scanner is required for production; wire the seam if so    | Unassigned | TBD    |
| R-10 | Require MFA for owner roles; shorten the owner session TTL                  | Unassigned | TBD    |
| R-11 | Scheduled anchor verification with an alert on a gap                        | Unassigned | TBD    |
| R-12 | Host allowlist for sink connectors, enforced on the connector definition    | Unassigned | TBD    |
| R-13 | Keep the bounded validation rule; add a load probe on the widest endpoint   | Unassigned | TBD    |
| R-14 | Keep the sandbox restrictions; test them as an escape attempt, not a config | Unassigned | TBD    |
| R-15 | Require a migration review by a human for every destructive statement       | Unassigned | TBD    |

> [!note] Two treatments are already funded work
> R-04's evaluation suite and R-06's audit gate are on the delivery plan. The
> rest need an owner before they mean anything.

## Risk in the agentic delivery process

An agentic pipeline changes the shape of security risk in three ways, and the
register above reflects all three.

**Volume moves the bottleneck.** When agents author most of the code, human
review stops being able to cover everything. Review must be tiered by risk:
migrations, row-level security policies, permission declarations and public API
changes are always read by a person; presentation and translation changes are
sampled. A tiering that is not written down defaults to reviewing whatever is
in front of the reviewer, which is the wrong selection.

**Capability is declared, not inferred.** An agent's reachable surface must come
from a declaration the agent cannot edit. The platform holds this line already,
and it is the single control that makes the rest tractable.

**Regression is invisible without evaluation.** A change to an instruction file
can degrade output quality with no failing test. Until the evaluation suite
exists, a skill edit is an unmeasured change to the thing that writes production
code. This is R-04, and it is the highest scored entry on the register for that
reason.

## Incident response hooks

The platform provides the evidence an incident needs, and this section names
where it is rather than restating the response process.

- Audit chain: sealed, anchored segments; a verification command reports a gap.
- Structured logs: `FD_LOG_FORMAT=json`, one object per line, trace id on every
  line.
- Traces: OTLP export when configured, with propagation through unsampled spans.
- Error sink: webhook egress for logged errors.
- Migration ledger: what ran, when, and under which checksum.

A response that requires granting `BYPASSRLS` to read across tenants is
R-02. Use the background role, which is cross-tenant and read-only by design.

## Review and acceptance

This document is accepted when an approver signs it, every register row has an
owner, and every treatment has a target date. Until then it carries status
`Draft for review` and the classification on the cover.

The register is versioned with the platform. A change to a platform invariant
requires a re-score of every risk that cites it, in the same cycle as the
change, not the next one.
