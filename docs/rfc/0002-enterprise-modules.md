# RFC 0002: Enterprise modules and capabilities

- Status: accepted by the owner on 2026-09-11; delivery follows the proposed order
- Date: 2026-09-02
- Companion to: RFC 0001 (enterprise readiness, data retention first)
- Relates to: ADR 0003 (module settings), ADR 0004 (enterprise access and audit), ADR 0006 (agentic workflows), ADR 0007 (module-owned agents), ADR 0008 (database adapter contract)

## Scope and honesty statement

RFC 0001 asks whether Flowdular can answer a buyer's security and data
protection questionnaire. This document asks a different question: whether a
buyer can run their business on Flowdular without first building the missing
half themselves.

The two do not overlap. Retention policy, per-tenant export, erasure, legal
hold, audit archival, backup and recovery, key rotation, access review
reporting, and data residency belong to 0001 and are not restated here. Where
this document reaches one of them it points at the gap number in 0001 rather
than proposing a competing answer.

Flowdular asserts no conformance with any named framework. Nothing in this
repository claims SOC 2, ISO 27001, GDPR, or HIPAA status. Where a framework is
named below it describes what a future audit would examine, not a control that
is met today.

Everything in "What exists today" was read out of the tree on the date above.
Line numbers move, so file paths and symbol names are the durable references.
One caveat on freshness: `modules/auth`, `packages/sandbox` and
`packages/landing` were under concurrent edit while this was written. The auth
findings should be re-read before any of this is scheduled.

## The judgement this document makes

A list of product names is not useful. For every gap below the document states
one of three verdicts.

**Module.** A slice with its own tables, permissions, endpoints and screens,
created from an approved `spec/module.yaml` and enabled through the CLI. This is
the cheap verdict. `modules/catalog` is the shape, and the lifecycle in
`docs/modules.md` already works.

**Platform capability.** Something in `packages/**` that every module can reach:
a field on `PlatformServerContext`, a registry in `packages/kernel`, a new
contract in `packages/contracts`. This is the expensive verdict, and the cost is
concrete. `PlatformServerContext` has eight fields and is declared in
`modules/auth/src/server/composition.ts`, so a ninth field is a change that all
twelve modules and `platform/src/generated/**` recompile against. The
`capabilities` list in `packages/contracts/schemas/module.schema.json` is a
closed set of six strings (`api`, `database`, `client`, `translations`,
`integration`, `cli`), so a genuinely new kind of contribution is a schema
change, not a module change.

**Neither.** An integration the customer writes on the module contract that
already exists. Flowdular is a foundation, and some things a buyer asks for are
their product rather than the platform's.

Getting the verdict wrong is expensive in both directions. A platform primitive
built as a module gets duplicated once per consumer, which is what the three
drifted audit chain verifiers in 0001 already show. A module built as a platform
primitive freezes a business decision into a contract nobody can change without
a blueprint version bump.

## What exists today

### The twelve modules

| Module             | Owns                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system.core`      | Application shell, module discovery, the module settings screen. Owns no tables.                                                                    |
| `auth.core`        | Accounts, sessions, memberships, scopes, roles, API tokens, invitations, TOTP MFA, the module settings store, the auth audit trail. Fifteen tables. |
| `users.core`       | The member directory and administration screens. Owns no tables; calls auth.core's administration port.                                             |
| `profile.core`     | A person's own display name, interface language, own sessions. Two tables.                                                                          |
| `agents.core`      | Agent definitions, provider connections, procedures, durable run execution, run history, cost metering.                                             |
| `workflows.core`   | Versioned DAG definitions, publication, simulation, durable run execution.                                                                          |
| `automations.core` | Schedules and signed inbound webhooks that start agent or workflow work.                                                                            |
| `catalog.core`     | Products and services with SKUs, prices, lifecycle state, revision history.                                                                         |
| `parties.core`     | Customers and suppliers, the same shape as catalog.                                                                                                 |
| `expenses.core`    | Expense claims with a submit and decide flow.                                                                                                       |
| `sandbox.core`     | Sandbox access grants, session metadata, audit chain.                                                                                               |

Sixty-seven tables across the ten modules that own any. Every module declares
`tenancy: required` and `stability: experimental`. Eleven use `profile: full`;
the `headless` and `ui` profiles are declared in the schema and unused.

### Identity, and how far federation actually goes

The task of establishing what federation exists has a more interesting answer
than "none".

OIDC sign-in is implemented. `GET /api/auth/oidc/:provider/start` and
`GET /api/auth/oidc/:provider/callback` in
`modules/auth/src/server/endpoints.ts` run an authorization code flow with PKCE
S256, seal the state and verifier into an HMAC envelope keyed by the provider's
client secret, and bound every leg: a ten second timeout per request, a 64 KiB
response cap, HTTPS-only endpoints. The callback requires
`email_verified === true`. The work is careful.

Five things it is not.

It is not SAML. The only occurrence of the word in the module is a label branch
in `modules/auth/src/client/AuthenticationCore.tsrx`, which maps a provider id
of `saml` to the display string "SAML SSO". A provider configured under that id
would render a SAML button over the OIDC code path. That is a trap, not a
feature.

It does not verify an ID token. The callback reads `access_token` and calls the
userinfo endpoint. There is no ID token parse, no signature check, no `iss`,
`aud` or `nonce` validation, and no JWKS fetch anywhere in the tree. There is no
discovery either, so every endpoint is hand-configured.

It does not provision. `AuthService.signInVerifiedExternalEmail` looks the
account up by normalized email and throws invalid credentials when there is
none. An OIDC user must already exist locally. Since account creation happens
through an invitation, and invitations cannot be sent (see the next section),
the federated sign-in path is reachable in production only for accounts created
some other way.

It is not bound to a tenant. Providers come from `FD_AUTH_OIDC_PROVIDERS`, a
deployment environment variable holding at most eight entries, and
`signInProviders` (which of them appear on the sign-in screen) is declared
`scope: 'platform'`. Every tenant in a deployment sees the same list. There is
no `tenant_id` anywhere in the OIDC path and no table storing provider
configuration. The trust relation is therefore "every configured identity
provider is trusted to assert any account", because identity is matched on the
email claim alone with no stored provider subject.

There is no SCIM and no LDAP. Both return zero occurrences repository-wide
outside marketing copy.

The same platform-versus-tenant split runs through the rest of the login policy.
Of the seven settings in `modules/auth/src/settings.ts`, six are
`scope: 'platform'`: sign-up availability, email confirmation, session lifetime,
idle timeout, minimum password length, and the provider list. Only
`defaultLocale` is tenant scoped. So there is no per-tenant password policy, no
allowed email domain, no per-tenant session lifetime, and no way to require MFA:
MFA is per account and opt-in, with no unenrol path and no way for an
administrator to clear a lost authenticator.

What does exist and is genuinely useful: `auth_roles` gives every tenant real
custom roles validated against a grantable scope list, `auth_membership_scopes`
carries per-member deviation from the role, `auth_api_tokens` are hashed with a
365 day ceiling and re-intersected with live membership scopes on every request,
and API tokens are structurally barred from minting or revoking tokens.

### The agentic side, and the egress ceiling

This is the part of the tree with the most engineering in it, and it is closed
with respect to the outside world.

Inbound is well built. `POST /api/automations/triggers/:id/fire` is the only
`access: { kind: 'public' }` endpoint in the repository. It carries an
HMAC-SHA256 signature over `v1.<timestamp>.<body>`, a five minute freshness
window, a 16 KiB body cap, constant-time comparison, a per-process decoy secret
so an unknown trigger id costs the same work as a known one, and a token bucket
rate limiter. Replays inside the window are absorbed by an idempotency key with
a unique constraint rather than rejected outright.

Outbound does not exist. There are exactly two kinds of server-initiated network
call in the tree: AI provider requests, deliberately fenced by
`modules/agents/src/services/outbound-policy.ts` (host allowlist, HTTPS only,
redirects refused, private and loopback address ranges blocked), and the OIDC
token and userinfo exchange during sign-in. No domain event in Flowdular causes
an HTTP request to a customer system. There is no signing helper for an outbound
request, no endpoint registration table, and no delivery attempt record.

The ceiling is enforced, not accidental. `risk: 'external'` is a declared value
in `packages/contracts`, and no code path can execute a tool that declares it:
`defineCliAgentTool` throws on it, and `descriptor()` in
`modules/agents/src/server/action-execution.ts` filters anything that is not
`read` or `workspace-write` out of the workflow action catalog. The eight
workflow node kinds (`input`, `agent`, `agent-decision`, `gate`, `validator`,
`action`, `merge`, `output`) are a closed union with no HTTP node and no notify
node. Five agent tools ship, all of them reads or writes against the owning
module's own tables.

That single fact decides the largest gap in this document. Adding an outward
effect is not a module change. Every seam a module has is currently incapable of
expressing one.

Scheduling is module owned. `automations.core` runs a `setInterval` loop with a
poll interval from a module setting. The cadence grammar is `every:N` minutes
between 1 and 10080; the word `cron` appears nowhere in the tree, so there is no
calendar expression and no timezone. There is no platform scheduler, no job
table, no outbox, and no dead letter table. Retry and backoff exist, but only
inside workflow node execution.

### Business modules, and what they reveal about scale

The three business examples are consistent with each other and consistent in one
uncomfortable way.

`SELECT ... FROM parties WHERE tenant_id = $1 ORDER BY lower(name), id` has no
`LIMIT`. Neither does the catalog list, nor the expenses lists. Every list
endpoint returns the tenant's whole table, and the screen filters it in the
browser: `filterParties` in `modules/parties/src/client/party-list.ts` is the
search box. Three of the four dashboard widgets produce their metric by
downloading the full list and calling `.length`.

`packages/ui` matches. `Table` is configured with a core row model only, no
sorted, filtered or paginated row model. `TableCard` has an `after` slot whose
documentation says "Between the table and the note: pagination", which is a slot
for something no shared code provides.

This matters for three separate gaps below. Search, bulk import, and reporting
all land on list endpoints that today have no pagination, so none of them can be
built without fixing that first.

Expenses is the only approval flow in the tree. Four states (`draft`,
`submitted`, `approved`, `rejected`), one decision permission
(`expenses.claims.approve`), a mandatory decision comment enforced by a table
level `CHECK`, and no un-submit, re-open, resubmit, delegation, escalation,
assignment or deadline. The logic lives in
`modules/expenses/src/services/expenses-service.ts` and is not shared with
anything.

### The administration surface

`system.core` shows an administrator the module list read off disk, a workspace
overview, and the module settings screen. It can change exactly one thing:
`POST /api/settings/update`, one key at a time, requiring a browser session so an
API token cannot do it. Enabling or disabling a module stays a CLI operation and
the screen renders the CLI command as text.

Only three of twelve modules declare any settings at all: auth, agents,
automations. The other nine render "This module declares no settings."

Two declared platform scopes, `system.specs.read` and `system.runs.read`, gate
nothing. Three declared auth scopes, `auth.profile.read`, `auth.session.manage`
and `auth.account.manage`, have no `requireScope` call anywhere. Those are small
tidiness items, not gaps, but a buyer's reviewer reading the permission list
will find them.

### The cross-module seam

There is no event bus. Not a small one, not an internal one. Cross-module
communication is exclusively `PlatformCapabilityRegistry` in
`packages/kernel/src/capability-registry.ts`: a `Map<string, unknown>` with
register-once semantics, a dotted id pattern, and `has()` for feature detection.
Five capability ids are registered today, versioned by convention
(`workflows.execution.v1`, `automations.targets.v1`, three agent ones).

Two consequences worth stating because they shape several proposals below.

Consumers look capabilities up inside a thunk, not at composition time, because
there is no ordering guarantee. `modules/automations/src/platform.ts` does this
and throws its own error when the capability is absent. There is no declaration
mechanism: `module.json` dependencies are not consulted at runtime, and the
consumer imports the provider's types directly, so it takes a hard package
dependency anyway.

Nothing can react to another module's domain change. There is no publish, no
subscribe, no fan-out, no ordering, no delivery guarantee and no replay.
`automations.core` glues the workflow execution capability to its own target
registry in code, which is what a bus would otherwise do.

One more platform fact with consequences: there is no permission registry.
`RegisteredModule.permissions` exists in contracts and nothing at runtime reads
it into the role model. The built-in roles are assembled from
`BUNDLED_MODULE_SCOPES` in `modules/auth/src/acl/scopes.ts`, a literal object
naming the scopes of users, parties, catalog, agents and sandbox. Expenses,
workflows and automations are not in it. Every new module proposed below
therefore carries the same wiring cost, and `access.core` from ADR 0004 is the
right eventual owner.

### What the tenancy model allows a cross-tenant reader to do

This section exists because three of the gaps below are the kind that would
normally be solved with a query across tenants, and that is not available.

Three PostgreSQL roles, all `NOSUPERUSER NOBYPASSRLS`.
`coreloom_migrator` owns the schema. `coreloom_runtime` serves requests and its
adapter is constructed `tenantRequired: true`, so there is no root level
`query()` on it at all and a transaction without a tenant id raises
`TENANT_CONTEXT_REQUIRED`. `coreloom_background` is granted `CONNECT` and
`USAGE ON SCHEMA public` and nothing else. Every table privilege it holds comes
from an explicit per-table column grant written in a module migration.

Fourteen tables carry a `*_background_policy` today, each paired with a
`REVOKE SELECT` and a narrow `GRANT SELECT (columns)`. Read the grant lists
together and the design intent is unmistakable: `(tenant_id, id)`,
`(tenant_id, id, next_run_at, enabled)`, `(token_hash, tenant_id, account_id,
expires_at)`, `(tenant_id, id, run_id, kind, payload_hash, expires_at)`. Every
granted column is a routing or identity column. Not one business value column,
and not one monetary column, is granted to that role anywhere in the tree.

The rule the documentation states, and that PostgreSQL actually enforces, is
that column privileges are checked inside `WHERE` clauses too. So the grant list
is not advisory. `modules/automations/tests/module.test.ts` asserts this
directly, first checking `current_user = 'coreloom_background'` so the test
cannot pass by reading nothing, then proving that selecting `label`,
`input_template` or `permission_snapshot_json` is refused.

A naive `SELECT tenant_id, count(*) FROM expenses_claims GROUP BY tenant_id`
fails three different ways depending on the role, and the differences matter:

- On `coreloom_runtime` it cannot be issued. Root queries throw, and a
  transaction needs a tenant id, at which point the policy reduces the answer to
  one group. The failure is silent and looks like a correct answer for one
  tenant.
- On `coreloom_background` it is refused at the column level before row security
  is consulted, because `expenses_claims` has no background policy and no grant.
- On `coreloom_migrator` it runs and returns zero rows, because every tenant
  table declares `FORCE ROW LEVEL SECURITY`, which is exactly the clause that
  applies row security to the table owner, and the setting is unset so the
  predicate compares against NULL. This is the worst of the three, because an
  empty result reads like an empty dataset.

There is a live instance of that third failure in the tree. The agents
repository routes boot-time catalog work through the migration lease with no
tenant context. In production it returns nothing; under PGlite, where the
migrator pool runs as the embedded superuser with no `SET ROLE`, it sees every
row. Local and test runs therefore behave differently from production. That is
worth its own look and this RFC does not schedule it, but no design below should
copy the pattern.

One gap in the guard rails: `packages/cli/src/migration-audit.ts` reports
`BACKGROUND_POLICY_TOO_WIDE` when a background policy lacks `FOR SELECT` or
carries a `WITH CHECK`, but it does not verify that a `REVOKE` and a narrow
column grant accompany the policy. That part is convention. If cross-tenant
reads grow, the check should grow with them.

## How the cross-tenant problem is actually resolved

The short answer is that almost none of the gaps below need a cross-tenant read,
and the one that does has a bounded, reviewable mechanism.

**Tenant-facing reporting needs no cross-tenant read at all.** The proof is in
the tree. `agent_run_costs` is a fact table with `tenant_id`, forced row
security, a precomputed `day` bucket written at run completion, and two indexes.
`usageByDay` and `usageByAgent` are the only `GROUP BY` queries in the
repository and both run inside `#tx(tenantId, 'read', ...)`, against the tenant's
own rows, through the ordinary runtime role. Integer micro-USD arithmetic
throughout so a rollup of many rows cannot drift. That is the "explicit read
model" the architecture blueprint already requires for shared reporting, built
once, correctly.

The contrast is equally instructive. `system.core`'s workspace overview
produces a fourteen day activity series by paging the audit trail through the
service and bucketing in JavaScript, capped at fifty pages. Its own comment
concedes the window is page-capped and that the precise fix is a count-by-day
aggregate. Same job, no read model, so it happens in application code and is
bounded by a magic number.

So the reporting answer is: per-module rollups written at the point of change,
tenant-keyed, under the same forced row security as everything else, and read
inside the tenant's transaction. No new role, no new lease purpose, no widening
of any grant.

**Search resolves the same way**, per tenant, with the same conclusion.

**Directory synchronisation does not need a cross-tenant read either**, provided
the identity provider binding is tenant scoped. This is worth noticing, because
it is a second and independent argument for fixing the binding. If provider
configuration stays deployment-wide as it is today, a sync job has no tenant to
run under and would need to discover the tenant list on the background role,
which is precisely the shape this model is built to avoid. Bind the provider to
the tenant and the sync runs per tenant on the runtime handle like any other
work.

**One genuine cross-tenant need remains**: operator-level metering across the
whole deployment, which is the vendor's own view rather than a tenant's. The
precedent already exists and shows both the mechanism and its cost.
`agent_provider_connections` gained a background policy granting exactly
`(id, enabled)`, and the summary query over it is deployment-wide with no
`GROUP BY tenant_id`, because `tenant_id` is not in the grant and could not be
added without a migration saying so.

That is the right property to keep. Any cross-tenant aggregate must name its
columns in a migration, which makes the set of columns that leave tenant scope a
versioned, reviewable, greppable declaration rather than a query someone wrote.
The recommendation is therefore to keep operator metering deliberately coarse:
counts and sums the operator genuinely needs, each column argued for in the
migration that grants it, and never a path that lets an operator read tenant
business data by widening a grant for convenience.

## Gaps

### G1. Outbound delivery: email, webhooks, and in-app notification

**Verdict: platform capability for the transport, module for everything a person
sees.** The split is forced by composition order, not by taste.

`auth.core` needs to send a message before any other module has loaded, so the
delivery port cannot live in a module that depends on it. It already has the
right shape: `AuthMailDelivery` in `modules/auth/src/services/mail-delivery.ts`
is an injected port whose own comment says auth.core "never selects an SMTP,
transactional-email, or provider SDK on its own". That judgement is correct and
should be generalised rather than replaced.

What is missing is that nothing implements it. `DevelopmentMailDelivery` keeps
messages in an array, is gated on `FD_AUTH_DEVELOPMENT_MAIL`, and that flag
throws when `NODE_ENV` is production. No composition anywhere passes a
`mailDelivery`. The consequences in a production deployment are exact:

- `createTenantInvitation` throws `MAIL_NOT_CONFIGURED` with status 503, and it
  never returns the raw token, so there is no way to obtain an invitation link
  out of band. Inviting a user is impossible.
- `requestPasswordReset` returns silently, because the guard is
  `if (!account || !this.#mailDelivery) return;` and the method is
  deliberately non-enumerating. Every reset request is dropped without a trace.
- Email confirmation cannot be enabled; the settings screen renders the key as
  locked.

That is the single most serious finding in this document and it is not a missing
enterprise feature. A production Flowdular cannot onboard a user or recover an
account. Everything else here can wait behind it.

Shape: promote the port to `PlatformServerContext` with a message kind
discriminator rather than auth's two-value union, and ship one real adapter,
most cheaply SMTP, chosen by configuration. Then a `notifications.core` module
owning what a person and a customer system actually interact with: per-user and
per-tenant preferences, an in-app inbox, outbound webhook subscriptions with a
signing secret, delivery attempt records, bounded retry with backoff, and a dead
letter path that a tenant administrator can inspect and replay.

The outbound webhook direction should reuse the inbound design that already
works: HMAC-SHA256 over a versioned string, a timestamp header, and a documented
verification recipe, so a customer implements one scheme in both directions.

Extends: `PlatformServerContext`; the capability registry for the module's
service; the module settings contract for preferences.

Depends on: nothing for the transport. The retry and dead letter store is the
first thing in the tree that genuinely wants a durable job runner, and the
honest options are to give the module its own queue table and poll loop the way
`automations.core` does, or to promote a job primitive to the platform. Prefer
the former first; a second module-owned loop is evidence for the primitive, one
is not.

Risk: this is the gap that opens Flowdular's egress. The tool risk ceiling exists
for a reason, and a webhook subscription is a tenant-configurable outbound
request to an arbitrary URL. It needs the same treatment `outbound-policy.ts`
already gives provider calls: an explicit allowlist or at minimum a block on
private and loopback address ranges, no redirect following, a response size cap,
and a timeout. Retention of delivery bodies is a 0001 question and the data class
registry from 0001 G2 should cover them from the start.

### G2. Identity federation and directory provisioning

**Verdict: split.** The identity provider binding belongs in `auth.core`. SCIM
provisioning belongs in a separate module.

The binding is on the sign-in hot path, needs the session issue code, and is
meaningless separated from `signInVerifiedExternalEmail`. Putting it anywhere
else means a second module in the authentication path, which is worse than a
larger `auth.core`.

SCIM is the opposite: a batch back-office surface with its own bearer token
model, its own schema, its own conformance surface, and no involvement in
sign-in. `auth.core` is already the largest module in the tree and holds the
session path; adding a provisioning API to it buys nothing and costs review
attention where it is most expensive. A `directory.core` module depending on
auth.core's administration port is the better boundary, and that port already
exists because `users.core` uses it for exactly this class of operation.

The tenancy consequence is the substantial part of this gap. Moving provider
configuration from `FD_AUTH_OIDC_PROVIDERS` to a tenant-owned table changes what
a tenant is. Today a tenant is a row in `auth_tenants` and an account is global,
with `auth_accounts` deliberately carrying no `tenant_id`. A per-tenant identity
provider makes the tenant an authentication authority, which raises three
questions the current model has never had to answer: which tenant a sign-in
belongs to before a session exists, what happens when one email is asserted by
two tenants' providers, and whether an account created by tenant A's provider
may be admitted to tenant B. The present code sidesteps all three by picking the
oldest membership, and that is not a defensible answer once providers are
tenant-owned.

Shape, in the order the work actually decomposes:

1. Harden the existing flow. Verify the ID token and its `iss`, `aud` and
   `nonce`, fetch and cache JWKS, and store the provider subject alongside the
   account so identity stops being an email string. Remove or implement the
   `saml` label branch. None of this changes the tenancy model and all of it is
   needed regardless of what comes next.
2. Move provider configuration into a tenant-owned table with the client secret
   in a vault envelope carrying a key id, so it joins the keyring in 0001 G7
   rather than becoming a seventh un-rotatable secret. Route sign-in by the
   workspace the user is entering rather than by a deployment-wide list.
3. Add just-in-time provisioning gated per provider, with the role a new member
   receives declared in the binding, and an allowed email domain check that the
   platform-scoped settings cannot express today.
4. Then `directory.core` for SCIM 2.0 users and groups, mapping groups to
   `auth_roles` and deactivation to the existing member status path.

Extends: `auth_tenants` and the auth administration port; the vault pattern from
0001 G7; `access.core` from ADR 0004 eventually owns the group to role mapping.

Depends on: G1 for anything that emails a newly provisioned user. Step 1 depends
on nothing and should not wait for the rest.

Risk: the highest in this document. This is authentication, and the blueprint
already classifies "add a new authentication strategy" as work requiring
decomposition. Deactivation semantics are a live trap: `auth_accounts.status` is
global, so disabling a member in one workspace signs them out of every workspace
they belong to. A SCIM deprovision from one tenant's directory would inherit
that behaviour and lock a person out of an unrelated customer's workspace. Per
membership status has to land before SCIM does.

### G3. Documents and file storage

**Verdict: platform capability for the store, module for the documents.**

Nothing in the platform stores a file. No multipart handling, no object storage
client of any kind, no attachment table, no file field in any domain type. Every
request and response in every module is JSON. The one file path in the
repository is `packages/sandbox/src/server/attachments.ts`, which writes base64
payloads to local disk for the development agent's own context, capped at ten
files of 5 MiB with an extension allowlist and magic byte verification. It is
not tenant scoped, not in the platform database, and not reachable from a
module.

Meanwhile the business examples imply files everywhere. An expense claim without
a receipt is a demonstration, not a product.

Shape: a storage port on `PlatformServerContext` with a local filesystem adapter
for development and an S3-compatible adapter for deployment, exposing put, get,
delete and a time-limited read URL, with the tenant id part of the key rather
than part of the caller's request. Then a `documents.core` module owning
metadata: tenant, owner module, record reference, filename, content type, byte
size, checksum, uploader, and a permission pair. Modules attach by reference,
never by holding bytes.

Extends: `PlatformServerContext`; the endpoint contract, which has no multipart
path today.

Depends on: nothing technically. It should land before 0001 G5 and G6, because
export must include files and erasure must delete them, and retrofitting a
second storage system into both after the fact is the expensive order.

Risk: files are the one data class that lives outside PostgreSQL, so every
control 0001 builds on the database has to be built a second time here. Row
level security does not reach an object store, which means tenant isolation
becomes application logic plus key layout, and that is a real weakening of the
strongest property Flowdular currently has. It also introduces content the
platform has not validated: size limits, type allowlists and malware scanning
are a stated position, not an optional extra. Encryption and key rotation must
be designed in from the first write, per 0001 G7, not added later.

### G4. Approvals as a shared capability

**Verdict: platform capability, small, plus optional module surface.**

The architecture blueprint already names the missing piece. Its ACL model lists
`Policy` as "a data-dependent condition, such as an approval amount limit" and
states that a module provides permission ids and policies. The implementation is
`packages/kernel/src/acl.ts`, twenty lines, exposing
`authorize(principal, permission)` and nothing else. The policy half of the
documented model does not exist.

`workflows.core` states the same gap from the other side. Its spec excludes
external and destructive actions from the catalog "until a later approved
human-approval and approval-receipt contract exists". So the workflow engine is
blocked on the same missing contract that expenses worked around by writing its
own state machine.

Shape: a policy evaluation seam in the kernel that takes a principal, an action
and the record, and returns a decision; then an approval request contract owning
requested state, required approvers resolved from roles or scopes, decision,
comment, and an append-only decision record. Modules keep their own domain
states and delegate the question of who may decide, so `expenses.claims.approve`
keeps working and gains amount thresholds without expenses learning about
thresholds.

Extends: `packages/kernel/src/acl.ts`; the workflow node union, which is where
the human approval node lands once the contract exists.

Depends on: G1, because an approval nobody is told about is a queue nobody
looks at. Ideally `access.core` from ADR 0004, since approver resolution is a
grant question; it can be built against `auth_roles` first without needing a
rewrite later.

Risk: over-generalising. Two approval flows, one of them the only real
implementation in the tree, is thin evidence for a framework. The mitigation is
to build the policy seam first, which is small and independently useful, and to
let the second real consumer decide the shape of the request contract.

### G5. Reporting and analytics

**Verdict: platform capability for the read model contract, and explicitly not a
reporting module.**

A reporting module that reads other modules' tables is refused by two rules at
once. Data ownership says another module does not read the owner's tables and
uses the owner's public service instead. The tenancy model says the only role
that could read across owners is refused at the column level. Both point the
same way, and the blueprint already wrote the answer down: shared reporting uses
an explicit read model.

The one worked example is `agent_run_costs`, described in the cross-tenant
section above. Everything needed to generalise it is visible in that one table:
write the fact at the point of change inside the same transaction, precompute
the bucket so the aggregate is an index scan, key by tenant under forced row
security, use integer arithmetic, and read it inside the tenant's transaction.

Shape: a documented read model pattern plus the missing shared machinery. That
machinery is small and concrete: server-side pagination on list endpoints (which
nothing has), a stable cursor helper (which agents, workflows and auth each
implement separately today), and a reporting read that composes per-module
rollups through the capability registry rather than through SQL. A tenant
administrator gets a report by asking each module that declares one.

Extends: the capability registry; the endpoint contract for pagination;
`packages/ui`'s `Table`, which needs the sort and paginate row models it is
currently configured without.

Depends on: nothing hard. It is worth doing early because every module written
after it inherits the pattern, and every module written before it will need
retrofitting.

Risk: the tempting shortcut is a second database role or a materialized view
that reads across tenants, and that trades away the property that is currently
Flowdular's strongest. If an operator-level view is genuinely needed, it goes
through the background role with per-column grants as described above, and stays
coarse.

### G6. Data import and bulk operations

**Verdict: module, blocked on platform work that must come first.**

Nothing bulk exists. Every write endpoint takes one record. There is no CSV
path, no batch endpoint, no bulk edit. The only bulk operation in the
repository is `auth greenfield`, which is a development seed that refuses a
configured PostgreSQL server, and the only other repository-wide data operation
is `database reset`, which is destructive.

This is how an enterprise actually onboards, so it matters more than its
position in the list suggests. It is placed low because it cannot be built
first. An import needs pagination and a stable cursor from G5, a place to put
the uploaded file from G3, and something durable to run a long job on, which is
the same missing primitive G1 runs into.

Shape: an import module owning a job record with a per-row outcome, staged
validation that reports every failure rather than stopping at the first, an
explicit dry run, and a per-module import port so each module validates and
writes its own records through its own service. Modules keep their invariants:
the idempotency ledgers in catalog and parties are the right precedent for
making a re-run safe.

Extends: the capability registry for the per-module port; the CLI, since bulk
import is a natural operator command and `commands.json` already supports risk
gating and dry runs.

Depends on: G3, G5, and a durable job story.

Risk: an import writes thousands of rows through a path that was designed for
one, so every unbounded query it touches becomes a production incident. It also
concentrates permission: whoever can import can write anything the target module
accepts, which needs its own scope rather than reusing the module's manage
permission.

### G7. Search across modules

**Verdict: platform capability, deferred. A central search index module is
rejected.**

The rejection first. A search module owning an index of everyone's records
duplicates the tenancy boundary in a second store, breaks data ownership, needs
either a bus that does not exist or a cross-tenant read that the model refuses,
and has to be kept consistent with the truth by machinery nobody has built. It
is the most expensive possible answer to a problem the platform does not have
yet at any scale.

What exists today is thinner than it appears: no full text index anywhere, no
`tsvector`, no trigram index, not even an `ILIKE`. The search boxes filter an
array in the browser, and the command palette searches navigation entries rather
than records.

Shape, when it is warranted: a search provider contract each module implements
over its own tables, aggregated by the shell, with PostgreSQL full text indexes
per module. Same shape as reporting, same reason.

Depends on: G5, because search results are a paginated list and the platform has
no paginated list.

Risk: none in deferring it. The real risk is building it early and acquiring an
index to keep consistent before there is a bus to keep it consistent with.

### G8. The audit and compliance surface

**Verdict: module, and its content belongs to RFC 0001.**

ADR 0004 already assigns retention policy, redaction, export, and external sink
delivery to a proposed `audit.core`, and 0001 gaps G2 through G6 are that
module's specification. This RFC adds three notes and no new scope.

First, `audit.core` is where this document meets 0001, and the meeting point is
the data class registry from 0001 G2. Documents (G3) and notification delivery
records (G1) are data classes, and if they are not in the registry from the
start they will be invisible to retention, export and erasure.

Second, the module has an outbound half. "External sink delivery" in ADR 0004 is
an outbound effect, which the ceiling described above currently forbids. It
should consume G1's delivery capability rather than opening a second egress
path.

Third, 0001's own observation that three audit chain verifiers have already
drifted is an argument for building the anchor and verify contract once, in this
module, rather than five times.

Depends on: 0001's ordering, which puts backup and recovery first.

### G9. Metering, licensing and billing

**Verdict: metering is a platform capability worth generalising. Billing is
neither, and is rejected.**

Flowdular already meters, and does it well. `agent_run_costs` records tokens and
integer micro-USD per run, `AI_MODEL_PRICES` returns null rather than a guessed
price for an unlisted model, `usageCostMicros` is integer throughout so rollups
cannot drift, and two tenant settings (`monthlyCostCapUsd` and
`agentMonthlyCostCapUsd`) refuse enqueue with `BUDGET_EXCEEDED` once the month's
settled spend passes the cap. The enforcement is honest about its own limits: it
checks at enqueue against settled spend, so concurrent enqueues can overshoot,
and a running job is never killed. That is a correct trade stated plainly.

Nothing else is counted. No users, no tenants, no records, no storage, no
requests, and nothing gates a feature on an entitlement.

Billing is rejected as a Flowdular concern. Flowdular is a foundation a customer
builds their product on, and their pricing, invoicing, payment and dunning are
their product. Shipping a billing module would freeze a commercial model into a
platform that has no business holding one.

Licensing gating is rejected for the same reason plus a stronger one: the core
is MIT and self-hosted, so an entitlement check is both unenforceable and at
odds with the licence the project publishes.

What is worth doing is generalising the meter, because cost attribution is a
real buyer question and Flowdular already answers it for one resource. Shape: a
usage counter contract in the kernel that any module can write a tenant-scoped,
day-bucketed counter into, following the `agent_run_costs` layout exactly, plus
a quota check the module calls before accepting work. Storage, seats and record
counts then become three consumers instead of three inventions, and a customer
who does want to bill their own users has a defensible number to bill from.

Extends: `packages/kernel`; the module settings contract for caps.

Risk: low, and mostly the risk of over-building. One consumer exists. Generalise
the table shape and the check, not a metering framework.

### G10. Integration connectors

**Verdict: neither. Ship the contract, not the connectors.**

The reasoning is about liability rather than effort. Every shipped connector is
a permanent obligation to somebody else's API: their auth changes, their rate
limits, their deprecations, their schema. A foundation platform that ships a
handful of connectors acquires an unbounded maintenance surface and a support
expectation, in exchange for a feature that the buyer's own integration team
would rather write against a stable contract anyway.

The repository already reflects this instinct. The one place Flowdular does call
an external service, the AI provider path, is fenced by an explicit host
allowlist. `risk: 'external'` is declared and structurally unexecutable.

What a customer actually needs is the contract, and every piece of it is a gap
already accepted above: an outbound delivery path with signing and retry (G1),
inbound webhooks (which exist and are good), agent tools and workflow actions
(which exist), a credential vault (which exists in three places and needs the
keyring from 0001 G7), and documentation of all four in one place. The right
deliverable is that document plus a worked reference connector kept outside the
supported surface, so the pattern is demonstrated without the obligation.

The one platform change this implies is raising the tool risk ceiling
deliberately: `risk: 'external'` needs an execution path, with the egress policy,
the approval contract from G4 for destructive external actions, and audit
metadata that records the call without recording credentials, which ADR 0004
already requires.

## Proposed order

1. **G1, outbound delivery.** First because it is not an enterprise feature, it
   is a broken production path: no deployment can invite a user or complete a
   password reset. It also unblocks G4, G8's sinks, and G10's contract.
2. **G2 step 1, harden the existing OIDC flow.** ID token verification, JWKS,
   stored provider subject, and removing the misleading SAML label. Small, no
   tenancy change, and it removes a security claim the current code cannot
   support.
3. **G2 steps 2 to 4, tenant-bound providers and directory provisioning.** The
   thing procurement asks about first, and the thing the landing page already
   claims. Per-membership status has to land inside this work, before SCIM can
   deprovision safely.
4. **G8 and the 0001 sequence.** Backup first, per 0001 G1, then the retention,
   archival, hold and export work that gives `audit.core` its content.
5. **G4, the policy seam and approvals.** Cheap once G1 exists, unblocks the
   human approval node that `workflows.core` is explicitly waiting for.
6. **G3, documents and file storage.** Placed after the retention work starts so
   files enter the data class registry as it is being written, and before 0001
   G5 and G6, so export and erasure are built once.
7. **G5, the read model contract and pagination.** Every module written after
   this inherits it; every module written before needs retrofitting, so earlier
   is cheaper. Placed here only because the items above are either broken paths
   or buyer-blocking.
8. **G9, generalised metering.** Independent, small, and the natural companion
   to G5.
9. **G6, import and bulk operations.** Needs G3, G5 and a durable job story.
10. **G7, search.** Needs G5. No reason to start it sooner.
11. **G10, the connector contract.** Mostly documentation once G1 exists, plus
    the deliberate decision about the external risk ceiling.

The ordering principle: repair what is broken, then remove claims the code
cannot support, then build the contracts that later modules depend on, then the
modules themselves.

## The landing page claim, and the decision it needs

`packages/landing/src/landing.copy.ts` lists, under the Enterprise licensing
tier, "Enterprise integrations: SSO, SCIM, audit export" (line 369 in English,
line 804 in Polish). Set against the tree:

- **SSO** is partly real and easy to overstate. OIDC authorization code with
  PKCE works. It is deployment-wide rather than per tenant, verifies no ID
  token, matches identity on an email claim, and cannot provision a user. A
  buyer using the word SSO means their identity provider, their tenant, their
  users appearing automatically. The current flow is not that, and a technical
  evaluation will establish the difference in about ten minutes.
- **SCIM** does not exist. The string appears nowhere in the repository except
  this line of copy.
- **Audit export** does not exist. RFC 0001 G5 records that there is no export
  of any kind: no endpoint, no CLI command, no documented format.

Two of the three cannot be bought today, and they are printed in the column that
describes what the money buys.

The decision belongs to whoever owns the commercial position, and this RFC does
not make it. It puts it in front of the reader as a genuine either or:

**Either** these three become committed roadmap items with issues, owners and a
sequence, in which case G2 moves to the front of this list and the copy is a
promise the repository is visibly working towards.

**Or** the line comes off the page until they exist.

There is a third option that looks attractive and is not: sell it now and build
it when a customer asks. The first customer who asks will find that per-tenant
identity provider binding changes the tenancy model, which is the work item in
this document with the highest stated risk. That is not a sprint, and discovering
it during a paid engagement is the worst place to discover it.

My recommendation is the second option now and the first option in parallel:
change the copy to what is true today, open the roadmap items, and put the claim
back when the code carries it. The copy is the cheapest thing here to change, and
a claim that fails technical due diligence costs more than the claim earned. I
have not edited the file; the decision should be recorded before anyone does.

A smaller, related item: the `saml` display label in `AuthenticationCore.tsrx`
renders a button reading "SAML SSO" over an OIDC code path. That is a claim in
the product rather than the marketing, and it should go regardless of how the
copy decision lands.

## Corrections to RFC 0001

Two statements in 0001 were accurate when written and are now stale. Recording
them here rather than editing 0001, since that document is under review.

0001 states that thirteen tables carry a `*_background_policy`. There are
fourteen. The fourteenth is `agent_provider_connections`, added by
`modules/agents/migrations/0020_provider_summary_role.up.sql`, granting
`(id, enabled)` for the deployment-wide provider summary.

0001 states that twelve tables carry no `tenant_id`, and names five of them
(`agent_definition_execution_limits`, `agent_run_execution_limits`,
`agent_definition_output_limits`, `agent_run_output_limits`,
`agent_run_skill_snapshots`) as "less obviously right", noting that their
isolation depended on application join discipline. That has been fixed.
`modules/agents/migrations/0018_agent_child_tenant_isolation.up.sql` gives those
five, plus `agent_provider_model_readiness`, their own `tenant_id` backfilled
from the parent, deletes orphans, sets `NOT NULL`, and applies enabled and forced
row level security with the standard policy. The remaining count is six, and each
of the six is deliberate: `auth_accounts` is cross-tenant identity by design,
four more are account-scoped rather than workspace-scoped, and
`module_agent_definitions` is a platform catalog.

## Open questions

- Does the delivery port from G1 land on `PlatformServerContext`, or does
  `auth.core` keep owning it and every other module reach it through the
  capability registry. The first is cleaner and changes a contract all twelve
  modules compile against. The second is cheaper and leaves the platform's only
  egress owned by the authentication module.
- Is a durable job runner a platform primitive or a per-module loop. G1, G6 and
  0001's retention sweep all want one. `automations.core` already has one and
  `agents.core` has a second. Three consumers is usually the point to extract,
  but two of the three do not exist yet.
- Does a tenant-bound identity provider make the tenant an authentication
  authority, and if so what happens when two tenants' providers assert the same
  email. The current answer, oldest membership wins, is not defensible once
  providers are tenant-owned.
- Does per-membership account status land with G2 or before it. SCIM
  deprovisioning inherits the current global status semantics, which would let
  one customer's directory lock a person out of another customer's workspace.
- Should `risk: 'external'` gain an execution path at all, or should outward
  effects stay confined to the G1 delivery capability where they can be
  centrally policed. The second is more restrictive and much easier to audit.
- Which of the twelve modules should declare settings. Nine declare none today,
  and several of the gaps above assume a tenant administrator can configure
  behaviour that currently has no surface.
