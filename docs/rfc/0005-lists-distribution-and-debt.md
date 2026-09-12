# RFC 0005: Server-side lists, official module distribution and the recorded debt

- Status: accepted by the owner on 2026-09-12; first wave I1, I4, I2, I3, I6
  in that order, I7 at any point; I1 delivered on 2026-09-12, see
  `docs/reviews/lists-distribution-rfc0005-2026-09-12.md`
- Date: 2026-09-12
- Follows: RFC 0004 (platform services, first wave delivered on 2026-09-12,
  see `docs/reviews/platform-services-rfc0004-2026-09-12.md`), RFC 0003
  (official module distribution, MVP on 2026-09-10)
- Relates to: ADR 0003 (module settings), ADR 0005 (sandbox runtime), RFC
  0001 and RFC 0002 (enterprise readiness and modules)

## Why this document exists

RFC 0004 closed the services a module reaches for. What the tree still
carries is older and less visible: lists that load a whole workspace into one
response, a server-side `Table` mode with no consumer, three official modules
that no longer install on the core they were written for, follow-ups the last
two review rounds recorded, an audit backlog nobody re-triaged after two
deliveries, and a blueprint section that describes an agent layer that was
never built as drawn. This document reads the tree as it is on the date
above, gives a verdict per item and proposes an order.

The verdicts follow RFC 0002 and RFC 0004: **module** (its own tables,
permissions, screens, an approved spec), **platform capability** (a seam in
`packages/*` or `platform/*`), **distribution** (the official module
repository and the registry) or **documentation**.

## What exists today, read out of the tree

- Paging: the keyset helpers in `packages/server/src/pagination.ts`
  (`readPageQuery`, `encodeCursor`, `decodeCursor`, `pageResponse`,
  `keysetWhere`) are used by access, directory (provisioning log), documents,
  exports, import and search. Every other list still returns a whole set or a
  silent cap: `users.members.list` has no limit at all
  (`modules/users/src/services/users-service.ts:51`);
  `agents.definitions.list` and `workflows.definitions.list` load every
  definition; `agents.runs.list` caps at 100 with no cursor;
  `approvals.requests.list` caps at 200 and drops row 201 without a signal
  (`modules/approvals/src/domain/capability.ts:86`); automations schedules and
  triggers fan out into agents and target options in the same response;
  notifications inbox caps at 200; connectors calls take a fixed limit;
  `workflows.runs.list` pages with a module-local, unsigned text cursor
  (`modules/workflows/src/services/database-repository.ts:1444`).
- `Table` in `mode="server"` (RFC 0004 H13) is built, documented and tested
  in `packages/ui/tests/table-render.test.tsrx` and has no production
  consumer; documents and the provisioning log render a load-more list.
- `Table` has no row selection model and no bulk action slot
  (`packages/ui/src/components/Table.tsrx`: `onSelect` and `selectedKey`
  highlight one row for navigation). The capability card lists multi-row
  actions under what does not exist.
- Official modules: `Flowdular/official-modules` holds catalog, expenses and
  parties with approved specs, a release registry and a consumer test
  against the packed SDK. All three pin system.core at 0.5.0, auth.core at
  0.10.0 and platformApi at 0.1.0 exactly. The core is at system 0.7.2, auth
  0.13.6 and platform API 0.1.3, and the kernel now enforces the ranges
  (`packages/kernel/src/module-compatibility.ts:64`), so none of the three
  installs. The `.ai/references/catalog` copy carries the same pins.
- Mail: `context.mail` and `renderMailTemplate` exist; the two templates are
  literals in auth and notifications, in English, with no per-tenant wording.
- Sandbox: session archive, restore and delete, the `git-pr` delivery target
  (branch per session, `gh pr create`, compare link fallback) and the module
  update flow on an existing module all exist and are tested. `docs/sandbox.md`
  does not mention the `git-pr` target; the only description is the
  `release-eject-pr` skill.
- Agent layer: `docs/architecture-blueprint.md` section 14 (marked "not
  implemented as drawn" since 2026-09-11) promises eight verb-named skills,
  five rule files, YAML workflows, ten agent roles, a run artifact ledger and
  an approvals policy. What shipped is `.ai/skills` with 21 skills around
  `spec-interview`, `spec-approval`, `module-new`, `module-update` and
  `auto-review`, driven one skill per turn by `packages/sandbox`.
- Follow-ups recorded by the RFC 0004 reviews: a `jobBackoff(intervalMs)`
  helper for the seven copies of the backoff literal; auth mail wording by
  the recipient's locale; one focus trap shared by the palette and
  `packages/ui`; the exports catalogue endpoint opening the repository for a
  registry read.
- The system audit of 2026-09-10 left 22 issue rows and five findings open;
  the re-triage against the current tree is in the section below.
- No `TODO` or `FIXME` in `packages/*/src` or `modules/*/src`: unfinished
  work lives in the documents above, not in code.

## Gaps

### I1. Official modules against the current core

**Verdict: distribution, first.**

Re-release catalog, expenses and parties in `Flowdular/official-modules`
against the packed SDK 0.2.x: caret ranges on system and auth, `platformApi
^0.1.0`, the spec sections the current validator expects, data class
declarations for their tables, and where a list already pages a
`defineListExport` registration. Refresh the registry index, the review
records and the consumer test; refresh `.ai/references/catalog` from the
released catalog. Without this the "full publication" the owner deferred
ships an SDK with no installable official module.

Extends: the official module repository, `.ai/references/catalog`. Depends
on: the SDK pack from this tree. Risk: the modules were last exercised on
auth 0.10; the owner and member scope defaults changed in auth 0023 to 0030,
so the consumer test has to run on a fresh workspace and on an upgraded one.

### I2. Server-side lists on the shared cursor

**Verdict: platform pattern adoption, one module at a time.**

Move every list that returns a whole set or a silent cap onto
`readPageQuery`, the signed cursor and `pageResponse`, in this order of
harm: users members, approvals requests (the dropped row 201), agents
definitions and runs, workflows definitions, runs (replace the unsigned
cursor) and audit, automations schedules and triggers (split the fan-out
into their own endpoints), notifications inbox, webhooks and deliveries,
connectors instances and calls, directory tokens and groups. Each screen
adopts `Table mode="server"` with the sort and the filter pushed into SQL,
which gives the server mode its first consumers and retires the client-side
sort over a whole set.

Extends: every module above, no platform change. Depends on: nothing. Risk:
the diff is wide and mechanical; every endpoint keeps its response shape
except for the added `pagination` block, and every spec gains a paging
requirement under the owner's blanket approval.

### I3. Row selection and bulk actions

**Verdict: `packages/ui` plus the first consumers, the second half of RFC
0004 H4.**

A selection model on `Table` (a checkbox column, select all on the visible
page, a count, keyboard toggling) and a bulk action slot the module wires to
its own endpoint, bounded to the visible page, with the same `reason` a
`TableAction` carries. First consumers: users members (deactivate, assign a
role), notifications inbox (mark read, archive), documents (delete),
approvals (decide many). Every bulk endpoint is one mutation with a bounded
id list, CSRF, one permission and one audit event per row.

Extends: `packages/ui`, the four modules. Depends on: I2 for the screens that
move to server mode first. Risk: a bulk action over a stale page; the
endpoint reports per-id outcomes and the screen refreshes the page.

### I4. Follow-ups recorded by the RFC 0004 reviews

**Verdict: small, do them early.**

`jobBackoff(intervalMs)` in `@flowdular/server` replacing the seven literals;
auth mail wording by the recipient's locale (auth spec outOfScope today);
one focus trap implementation for the palette and `packages/ui`; the exports
catalogue endpoint reading the registry without opening the repository.

### I5. Mail wording per tenant

**Verdict: deferred; documentation until a business asks.**

A per-tenant template store (subject, text, HTML, per locale, with a preview
and a reset to the default) is a module-sized piece of work on top of
`renderMailTemplate`. Nothing in the tree needs it; the card keeps it under
what does not exist. The locale follow-up in I4 is the near piece.

### I6. The audit backlog, re-triaged

**Verdict: mixed; see the table.**

Re-read against the code on 2026-09-12, after RFC 0002 and RFC 0004:

| Issue                             | Status | Evidence in the tree                                                                                                 |
| --------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| #3 invite and reset delivery      | closed | the mail port refuses `development` in production (`packages/server/src/mail/config.ts:144`); auth sends through it  |
| #4 automation credential key      | closed | plumbed through build, both infra trees, env example and backup fingerprints                                         |
| #5 OIDC verification              | closed | signature, `iss`, `aud`, freshness, `nonce`, PKCE (`modules/auth/src/server/oidc.ts:305`)                            |
| #6 scope backfills and RLS        | closed | backfills lift and restore the force flag in one transaction; `auth sync-scopes` repairs                             |
| #7 swallowed audit failures       | open   | `modules/auth/src/services/auth-service.ts:452` logs and continues; no counter, no health surface                    |
| #8 service audit actor            | open   | auth 0014 still checks `actor_kind IN ('user','agent')`; operators are recorded as users                             |
| #9 truncated audit tail           | closed | seal verify fails on a missing anchor or a missing segment (`modules/audit/src/services/seal-service.ts:570,704`)    |
| #10 automation migration adoption | partly | 0003 and 0004 adopted on an index alone; 0005 checks the grant (`modules/automations/src/services/migration.ts:216`) |
| #11 key rotation                  | partly | key ids on every envelope and `secrets-rotate` per module; no re-sealing pass for storage and connectors             |
| #12 backup, restore, PITR         | partly | runbook and an embedded round trip; no PITR, restore gated to local                                                  |
| #13 external-effect approval      | partly | default denial and the connectors consent gate; the signed verifier is still planned                                 |
| #14 preflight migration lease     | open   | `modules/agents/src/services/module-agent-preflight.ts:29` takes the migration lease at boot                         |
| #15 legacy state copy             | open   | `packages/cli/src/state-migration.ts:25` copies SQLite files that PostgreSQL cannot use                              |
| #18 async settings contract       | open   | `ModuleSettingsStore` is synchronous (`packages/kernel/src/module-settings.ts:55`)                                   |
| #19 workflows success-route tests | open   | `modules/workflows/tests/endpoints.test.ts` has no authenticated POST reaching a handler                             |
| #20 sandbox directory N+1         | open   | `modules/sandbox/src/services/sandbox-service.ts:153` lists scopes once per member                                   |
| #21 password environment argument | closed | the CLI takes a variable name and fails closed on an empty value                                                     |
| #22 BIGINT parity                 | partly | PGlite returns int8 as text like node-postgres; 18 repository copies of `integer()` and no shared decoder            |

What stays open falls into three small pieces and three larger ones:

- Small, one stream: #7 (route the audit write failure through
  `context.metrics` and the error sink), #8 (a forward migration widening
  the actor kind to `service` with a persistence test), #10 (adoption checks
  for 0003 and 0004 that read the policy and the grant), #19 (one
  authenticated write per workflows route), #20 (a bulk scope read), #22
  (one `integer` decoder exported by `@flowdular/database`).
- #14 and #15: a tenant-aware runtime read for the agents preflight, and a
  state copy that names the SQLite files it cannot migrate.
- #18: an asynchronous settings store contract, a kernel change with a
  platform API bump.
- #11, #12, #13: re-sealing for the storage and connectors keys, PITR with a
  production restore path, the signed approval verifier. Each is an
  operations feature with its own RFC-sized decision; this document records
  them and schedules none.

### I7. Blueprint section 14 and the sandbox documentation

**Verdict: documentation.**

Rewrite section 14 of `docs/architecture-blueprint.md` to describe the agent
layer that shipped (the skill catalogue, the one-skill-per-turn loop, the
blueprints, the policies, the delivery targets) and record the parts of the
original drawing that were dropped and why (the run artifact ledger, the ten
roles, the YAML workflows). Add the `git-pr` delivery target to
`docs/sandbox.md` with its configuration keys.

### I8. Deferred by RFC 0004, unchanged

H9 (outbox) waits for a second module that needs decoupling; H10 (PDF) waits
for a business module naming the document; H11 (SAML) waits for a buyer.
Nothing in this reading changes those verdicts.

## Proposed order

1. **I1, official modules.** The publication the owner deferred depends on
   it.
2. **I4, the small follow-ups.** Already specified by the reviews.
3. **I2, server-side lists.** The widest diff; one module per stream with
   the users members list first.
4. **I3, selection and bulk actions.** On the screens I2 moved to server
   mode.
5. **I6, the small open audit items.** #7, #8, #10, #19, #20, #22, then
   #14 and #15; #18 with the next platform API bump.
6. **I7, documentation.** Can land any time.
7. **I5, I8.** When asked for.

## Decisions recorded on 2026-09-12

- First wave: I1, then I4 with the small I6 items, then I2, then I3, in the
  order proposed above; I7 lands at any point.
- I1 lands as its own pull request in the official module repository,
  tested against the SDK packed from this tree, before the npm publication.
- I3 starts on the users members list as soon as that list is on the server
  mode; the other screens follow as I2 moves them.

## Open questions for the owner, as they stood before the decisions

- Does I1 land in the official module repository as its own pull request
  before the npm publication, or together with it.
- Which items form the first wave, and is the order above acceptable.
- Should I3 (bulk actions) wait for I2 to finish, or ship on the users
  members list as soon as that list is on the server mode.
