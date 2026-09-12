# RFC 0001: Enterprise readiness, data retention first

- Status: G1 to G7 delivered with RFC 0002 (2026-09-12); G8 and G9 carried into RFC 0004
- Date: 2026-09-02
- Relates to: ADR 0003 (module settings), ADR 0004 (enterprise access and audit), ADR 0006 (agentic workflows), ADR 0008 (database adapter contract)

## Scope and honesty statement

Flowdular asserts no conformance with any named framework. Nothing in this
repository claims SOC 2, ISO 27001, GDPR, or HIPAA status, and a search of the
tree finds no such claim. Where this document names a framework it describes
what a future audit would examine, not a control that is met today.

Everything in the "What exists today" section was read out of the tree on the
date above. Line numbers move, so file paths and symbol names are the durable
references.

## What an enterprise buyer asks for

A buyer evaluating Flowdular as the foundation for their own platform sends a
security and data protection questionnaire before signing. The recurring items:

1. How long is each class of data kept, who sets that, and what proves the
   deletion happened.
2. Can a tenant get its own data out, in a documented format, without a support
   ticket.
3. Can a named person's data be erased on request, and what happens to the audit
   record of what that person did.
4. Can retention and erasure be suspended for named subjects under litigation.
5. What administrative activity is recorded, can that record be trusted, and who
   reviews the access list.
6. How is data encrypted, who holds the keys, and how are they rotated.
7. What is the backup position, and what recovery point has actually been
   tested.
8. Where does the data physically live.

Flowdular has real answers to parts of 1, 5, and 6. The rest is open. This RFC
records which is which and proposes an order.

## What exists today

### Tenant isolation and least privilege

This is the strongest part of the current position and it is genuinely built,
not documented aspiration.

Fifty-five tables across nine modules enable and force row-level security and
carry a policy with both `USING` and `WITH CHECK` bound to
`current_setting('coreloom.tenant_id', true)`. Every one of the fifty-five has
both `ENABLE` and `FORCE`. The only predicate variation is `auth_tenants`, which
correctly keys on `id` rather than `tenant_id`. No table that carries a
`tenant_id` column is left uncovered.

The tenant id is transaction local. `packages/database/src/postgresql.ts` issues
`SELECT set_config('coreloom.tenant_id', $1, true)` immediately after `BEGIN`,
with the third argument `true` meaning the setting reverts at the end of the
transaction. A runtime adapter is constructed with `tenantRequired: true` and
raises `TENANT_CONTEXT_REQUIRED` when a transaction opens without one.
`packages/database/src/provider.ts` refuses to start if the runtime role reports
`rolsuper` or `rolbypassrls`, so the forced policies cannot be silently bypassed.

Two axes are easy to confuse. The lease `purpose` in
`packages/database/src/contracts.ts` (`background`, `migration`, `preview`,
`runtime`, `test`) selects the database role, and that is the isolation axis.
The `access` mode on `DatabaseTransactionOptions` is only the SQL transaction
mode, `READ ONLY` or `READ WRITE`, and defaults to `READ WRITE` when omitted.

`infra/README.md` describes three roles created at cluster initialization:
`coreloom_migrator` owns the schema, `coreloom_runtime` holds neither
`SUPERUSER` nor `BYPASSRLS` so the forced policies actually bind it, and
`coreloom_background` serves cross-tenant polling with no default table grant.

The background role is restricted by column, not just by row. Thirteen tables
carry a `*_background_policy`, each paired with a `REVOKE SELECT` and a narrow
column grant, following the template in `docs/database-adapters.md`. On
`workflow_payloads` (`modules/workflows/migrations/0003_workflows_worker_role.up.sql`)
the grant is `(tenant_id, id, run_id, kind, payload_hash, expires_at)`, so
ciphertext, graphs, actors, and permission snapshots stay unreadable on the
connection that scans across tenants. PostgreSQL checks column privileges inside
`WHERE` clauses too, so the narrowing holds. Whatever acts on a row reads it
again under the tenant the row named.

Two honest qualifications.

Twelve tables carry no `tenant_id` at all, so they have no policy and no column
grant, and the default privileges give `coreloom_runtime` full DML on them.
Several are account-scoped by design and defensible: `auth_accounts` is
deliberately cross-tenant identity, and `auth_sign_in_failures`,
`auth_password_reset_tokens`, `auth_mfa_totp`, `auth_mfa_recovery_codes` are
keyed to an account rather than a workspace. Five are less obviously right:
`agent_definition_execution_limits`, `agent_run_execution_limits`,
`agent_definition_output_limits`, `agent_run_output_limits`, and
`agent_run_skill_snapshots` are per-run or per-definition child rows whose
parent is protected but which are not. Isolation for those depends on the
application's join discipline rather than on the database. That is worth a
separate review; it is not a retention question and this RFC does not schedule
it.

Second, the RLS mechanism itself is undocumented. `docs/database-adapters.md`
covers the roles and the background grant template but never states the
`USING`/`WITH CHECK` predicate or the `coreloom.tenant_id` setting; those live
only in migration SQL and in `infra/docker/postgres/10-roles.sh`. A buyer's
reviewer reading the docs cannot find the control that is the strongest thing
here.

### Payload retention in workflows

This is the only configurable retention in the product.

`FD_WORKFLOWS_PAYLOAD_RETENTION_MS` is read once in
`workflowsRuntimeOptionsFromEnvironment` (`modules/workflows/src/server/runtime.ts`).
It defaults to 24 hours, is clamped to a minimum of 0 and a maximum of 30 days,
and is passed into the repository constructor as a fixed number. It is a
deployment-wide value. `modules/workflows` declares no module settings, so a
tenant cannot see or change it.

When a run reaches a terminal state the repository sets
`expires_at = recordedAt + payloadRetentionMs` on that run's payloads.
`applyPayloadRetention` in
`modules/workflows/src/services/database-repository.ts` then does this, on every
worker drain, for at most 100 payloads per pass (the limit is clamped to 1000):

1. Scans candidates on the read-only background handle. The candidate query
   requires `kind = 'execution'`, a non-null `expires_at` at or before now, and a
   run status in `succeeded`, `failed`, `refused`, `cancelled`. Payloads of a
   live run are never swept.
2. For each candidate, opens a write transaction under the tenant that owns the
   row and appends a `payload.retention.applied` event carrying the payload id,
   its hash, the policy name `terminal-ttl`, and the prior evidence state. Note
   that this goes to `workflow_run_events`, the per-run stream, not to
   `workflow_audit_events`. The run stream is append-only and sequence numbered
   but not hash chained.
3. Rewrites the evidence documents on `workflow_runs`,
   `workflow_node_attempts`, and `workflow_edge_transfers` through the `expire()`
   helper, which strips `preview` and merges
   `{"state":"expired","reason":"retention"}`.
4. Deletes the `workflow_payloads` row, which is where the AES-256-GCM
   ciphertext lives.

What survives is `WorkflowPayloadEvidenceV1`
(`modules/workflows/src/domain/types.ts`) minus its preview: the schema id, the
content hash, the original byte size, and the new `expired` state with reason
`retention`. The run, its status transitions, revisions, actor, origin,
attempts, edge hashes, durations, usage, cost, and failures are untouched. The
run stream records that the redaction happened and the hash of what was removed,
so the deletion is itself evidence rather than a silent gap.

The shape is right and the rest of this RFC should copy it: the redaction is
recorded before it happens, what was removed stays identifiable by hash and
size, and nothing already written is rewritten. The one thing to improve when
generalizing it is where the record lands. A retention event that removes data
belongs in the tamper-evident trail, not only in an unchained per-run stream.

### Authentication failure retention

`FAILURE_RETENTION_MS` in `modules/auth/src/services/auth-service.ts` is
`24 * 60 * 60 * 1000`. It is a module-private constant. It is not a setting, not
an environment variable, and not tenant scoped.

It is applied inside the write path, not by a sweep.
`recordSignInFailure` in `modules/auth/src/services/database-repository.ts` runs
`DELETE FROM auth_sign_in_failures WHERE updated_at < $1` as its first statement
on every recorded failure. If nobody fails a sign-in, nothing is pruned.

This is lockout bookkeeping that happens to expire. Calling it a retention
policy would overstate it.

### Audit trails

Five append-only trails exist, all tenant scoped, all under forced row-level
security:

| Trail       | Table                      | Chained |
| ----------- | -------------------------- | ------- |
| auth        | `auth_audit`               | no      |
| agents      | `agent_audit_events_v4`    | yes     |
| sandbox     | `sandbox_audit_events`     | yes     |
| automations | `automations_audit_events` | yes     |
| workflows   | `workflow_audit_events`    | yes     |

The four chained trails carry `previous_hash` and `event_hash` and a per-tenant
`sequence`. Each chain is per tenant, so one tenant's history is independent of
another's. `auth_audit` is append-only with an identity primary key and no
chain, which ADR 0004 already states.

Nothing prunes, archives, rotates, or truncates any of these tables. Every
statement against an audit table in application code is a `SELECT` or an
`INSERT`. There is no `UPDATE` and no `DELETE` in production code, no retention
constant, no size or row cap, and no partitioning anywhere in the tree. The only
`TRUNCATE` statements are in test support files
(`modules/*/tests/support/database.ts`). The chains grow without bound for the
life of the deployment.

One destructive path exists and it is not retention: `flowdular database reset`
(`packages/cli/src/database.ts`, `packages/database/src/reset.ts`) enumerates
the schema catalog and drops every table including audit. It is marked
`risk: 'destructive'`, `localOnly: true`, requires `--apply --confirm
reset-database`, and dry-runs by default. It is an all-or-nothing local wipe,
not selective removal. Down migrations that drop the audit tables are authored
but dead: no runner executes a `.down.sql`.

Growth has a second source in agents. The table moved through v1, v2, v3, and
v4, and each up-migration copies rows forward with
`INSERT INTO <new> SELECT * FROM <old> ... ON CONFLICT DO NOTHING` without
dropping its predecessor. All four generations coexist, so the history that
existed at each migration point is stored four, three, and two times over
alongside the live table.

The copies did preserve both hash columns, so no chain has ever been broken or
re-anchored. That matters for the erasure discussion below.

Verification is a full walk. `verifyAuditChainDetailed` in
`modules/agents/src/services/database-repository.ts` runs
`SELECT * FROM agent_audit_events_v4 WHERE tenant_id = $1 ORDER BY sequence`
with no limit, materializes every row, seeds `previousHash` as `null`, and walks
forward recomputing each hash. `verifyAudit` in
`modules/workflows/src/services/database-repository.ts` and
`verifyAuditChain` in `modules/automations/src/services/database-repository.ts`
do the same over their tables. The agents walk backs both the
`flowdular agents audit-verify` CLI command and the HTTP verify endpoint, so the
two cannot disagree. Workflows and automations expose verification over HTTP
only; neither module has a CLI.

Four consequences follow directly from that code, and they matter for everything
below.

First, removing a row from the middle breaks verification in all three
implementations. The next row's `previous_hash` no longer matches its
predecessor's `event_hash`, and `sequence` is itself a hash input. Removing the
first row fails immediately, because the walk requires the first
`previous_hash` to be `null`.

Second, and less comfortably, removing the newest rows breaks nothing. Truncate
the tail of a chain and the surviving prefix verifies perfectly. No module
records a high-water mark, a row count, or an externally anchored head, so
verification proves that the retained history is internally consistent, not that
it is complete. This is the weakest point in the current integrity story and it
is independent of any retention decision.

Third, verification cost grows with the chain in both time and memory, because
every row is loaded in one query with no limit. An unbounded chain eventually
has an unrunnable verify. That is a scaling defect, not a policy question.

Fourth, there is no checkpoint or anchor to verify from, so there is no
supported way to verify a partial chain. Any archival design has to add one.

Three smaller divergences between the implementations, none of them a defect
today but all of them arguments for one owner:

- Only automations checks sequence contiguity (`expectedSequence`). Agents and
  workflows rely on the hash link alone, which catches the same cases through a
  different route.
- The workflows hash omits `tenantId` from its inputs, while agents and
  automations include it. The row is tenant-keyed by its primary key so this is
  not reachable through the repository, but a row moved between tenants would
  still verify.
- The automations recompute passes the row's own stored `previousHash` rather
  than the independently tracked value. The link is checked separately so the
  chain is still sound, but the recompute alone is not independent of stored
  data.

One test observation from the survey date has since been resolved:
`modules/agents/tests/audit-verify.test.ts` imported a repository symbol the
module no longer exported, so the test that proves agents' tamper detection
could not run. The rename landed and the agents suite passes. What still stands
is the gap it exposed: no test in any module deletes an audit row to exercise
gap detection. An integrity control that is not exercised by a test is not a control
a buyer should be shown.

### Secrets

Six secrets are supplied as environment variables and held outside the database.
Four encrypt, two sign:

| Variable                        | Use                         | Primitive   | Key id stored |
| ------------------------------- | --------------------------- | ----------- | ------------- |
| `FD_AGENT_CREDENTIAL_KEY`       | provider credentials        | AES-256-GCM | yes           |
| `FD_WORKFLOWS_PAYLOAD_KEY`      | workflow execution payloads | AES-256-GCM | yes           |
| `FD_AUTOMATIONS_CREDENTIAL_KEY` | automation secrets          | AES-256-GCM | yes           |
| `FD_AUTH_MFA_KEY`               | TOTP secrets                | AES-256-GCM | no            |
| `FD_WORKFLOWS_CURSOR_KEY`       | pagination cursors          | HMAC-SHA256 | no            |
| `FD_AGENT_RUN_GRANT_KEY`        | run grants                  | HMAC-SHA256 | no            |

`AesGcmCredentialVault` in `modules/agents/src/services/credential-vault.ts`
takes a base64 32-byte key and refuses to construct in production without it.
`createWorkflowPayloadCodec` in
`modules/workflows/src/services/payload-codec.ts` does the same, and binds each
ciphertext to its context with additional authenticated data over `tenantId`,
`runId`, and `payloadId`, so a payload cannot be moved between runs or tenants.

There is no key derivation anywhere. No HKDF, no scrypt or PBKDF2, no per-record
key. The environment variable bytes are the key.

Where a `keyId` is written it is a truncated SHA-256 fingerprint of the one
active key, not an index into a keyring. Each vault closes over exactly one key
buffer and rejects anything else: the credential vault raises "The credential
encryption key is unavailable", the payload codec raises
`WORKFLOW_PAYLOAD_UNREADABLE`. There
is no keyring, no key version register, and no re-encryption tool. A repo-wide
search for re-encrypt, rewrap, keyring, or a previous-key concept returns
nothing, and the CLI capability list contains no key operation.

So rotation today is destruction. `infra/README.md` states it plainly:
"Rotating `credentialKey` invalidates every stored provider credential; re-enter
them under Providers afterwards. Rotating `workflowsPayloadKey` makes retained
workflow execution payloads unreadable, so drain runs and let retention remove
payloads before rotating it." `docs/configuration.md` repeats the credential
warning. Nothing is said about rotating the run grant key, the cursor key, the
automations credential key, or the MFA key. That is a warning covering two of
six secrets, and it is not a procedure.

The two HMAC keys are the cheap cases. Rotating the cursor key invalidates
in-flight pagination, which clients recover from by re-paging. Rotating the run
grant key invalidates outstanding grants.

The encouraging detail is partial. Three of the four encryption envelopes
already carry a key id: the workflow envelope is `v1.keyId.iv.tag.data`, and the
credential and automation envelopes are records with a `keyId` field, with
`credential_key_id` and `encryption_key_id` persisted as columns. For those
three, making the vault resolve a key id against a keyring is a change to the
lookup, not to the stored format. The MFA vault is the exception: its envelope
is `iv.ciphertext.tag` and `auth_mfa_totp.secret_ciphertext` has no key id
column, so rotating that key needs a format and schema change first.

### Module settings, the seam a policy would use

`packages/kernel/src/module-settings.ts` defines `ModuleSettingDefinition` with
a type of `string`, `number`, or `boolean`, a default value, visibility, client
exposure, a `secret` flag, bounds, and a `scope` of `platform` or `tenant`.
Settings default to tenant scope. ADR 0003 records that environment variables
supply only the declared default and a stored value wins at read time, and that
reads are live rather than snapshotted at boot.

`modules/automations` already uses this correctly for a background loop.
`AUTOMATIONS_MODULE_SETTINGS` declares `schedulerPollMs`, and
`modules/automations/src/platform.ts` passes it to the runtime as a thunk,
`schedulerPollMs: () => automationsSchedulerPollMs(context.settings,
context.environment)`, so an administrator change takes effect without a
restart. The scheduler polls across tenants on the background handle and acts
per tenant.

That is the precedent. A retention policy is the same shape: a tenant-scoped
number per data class, read live, driving a cross-tenant scan on the background
handle and per-tenant writes.

One constraint to design around: setting values are scalars, so a policy per
data class needs one key per class rather than one JSON blob.

### What is already written down

ADR 0004 assigns retention policy, redaction, export, and external sink delivery
to a proposed `audit.core`, alongside `access.core` for roles and grants.
Neither module exists. ADR 0004 also requires that credentials, raw tokens, and
request bodies never enter audit metadata, which is a real minimization control
already in force.

ADR 0006 states the workflows position exactly: "The default metadata retention
is indefinite in version one. A future deletion policy requires a separate
approved spec because removing audit evidence is a compliance decision, not
storage cleanup."

This RFC is that separate spec. It does not create a competing home for the
work. It says what the words in ADR 0004 have to mean.

## Gaps

Each gap below is a gap. None of these are partially built.

### G1. Backup, restore, and point-in-time recovery guidance

`infra/` contains eleven files. None mentions backup, restore, snapshots,
point-in-time recovery, WAL archiving, `archive_command`, `pg_dump`,
`pg_basebackup`, or disaster recovery. The compose file defines a named Docker
volume for the PostgreSQL data directory and sets only TLS options; the
Kubernetes manifests assume an external PostgreSQL that the repo does not
provision or protect. The Kubernetes base carries no volume because the
deployment is stateless and everything lives in PostgreSQL, which makes that
database the single point of loss.

The repository already knows this. `docs/architecture-blueprint.md` lists
"Backup and restore drill" as an item under an unimplemented hardening stage,
and the migration rules mention "backup evidence" as a requirement for
destructive changes with no tooling behind it.

Shape: an operations document covering base backup and WAL archiving for the
compose and Kubernetes deployments, a restore procedure someone has actually
run, a stated recovery point objective and recovery time objective, and a note
on what a restore does to in-flight workflow leases and agent runs. The
encryption keys are outside the database, so the document must state that a
database restore without the matching keys yields unreadable payloads and
credentials.

Dependencies: none. This is the only item with no prerequisite.

### G2. A tenant-scoped retention policy per data class

Today there are two ad-hoc timers. One runs inside the workflow worker's drain
loop and covers execution payloads only. The other runs inside the sign-in
failure write path and covers lockout counters only. Both are deployment-wide.
Neither is visible to a tenant administrator.

What is missing is one policy surface covering the five classes that a
questionnaire asks about: audit events, run history, workflow payloads,
authentication events, and module business records.

Shape: a settings-declared retention duration per data class per module, tenant
scoped, with the current environment variables demoted to defaults. A single
scheduled sweep, following the `applyPayloadRetention` pattern: candidate scan
on the background handle with column-level grants, bounded batch size, per-tenant
write transaction, and an audit event recorded before each removal. A data class
registry so a module declares what it holds and how it is aged, rather than each
module inventing a timer.

Dependencies: G1 must land first. A sweep that deletes across five data classes
without a tested restore turns a policy bug into permanent data loss.

### G3. Audit trail archival

The four chained trails and `auth_audit` grow without bound, verification loads
the whole chain into memory, and tail truncation is undetectable. These are
three faces of one missing thing: an anchor.

Shape: periodic sealing. Close a chain segment at a chosen boundary, record a
segment anchor (last sequence, last `event_hash`, row count, time range), move
the sealed rows to cold storage in a documented format, and teach verification
to start from an anchor rather than from `previous_hash = null`. Verification
then costs the open segment plus a chain of anchors, and archived segments stay
verifiable offline against their anchor.

The same anchor closes the truncation hole, which is why this is worth doing
even for a deployment that never wants to archive anything. A recorded
high-water mark makes a missing tail detectable, and an anchor held outside the
database (or countersigned with a key the application does not hold) makes it
detectable by someone who does not trust the database.

While the tables are being touched, drop the superseded
`agent_audit_events`, `agent_audit_events_v2`, and `agent_audit_events_v3`
copies. That is a one-off reclamation, not a policy, and it should not wait for
the rest of this.

The verify contract change is the real work: `AuditChainVerification`,
`WorkflowAuditVerification`, the automations inline integrity result, the
`flowdular agents audit-verify` command, and the HTTP verify endpoints all
currently assume a chain that starts at the beginning. The three
implementations have already drifted in small ways (sequence contiguity, the
tenant id in the hash inputs, the source of the recomputed previous hash), which
argues for one owner rather than three parallel fixes. Add the missing tests
first: a deliberate mid-chain deletion, and a tail truncation that should fail
once an anchor exists.

Dependencies: G2, because sealing needs a cutoff, and the cutoff is a retention
setting. Note that archival is not deletion. Sealed rows are moved, not removed,
so this gap does not touch the erasure question.

### G4. Legal hold

There is no legal hold concept anywhere in the tree. A search for "legal hold",
"data subject", "erasure", and "right to be forgotten" returns nothing.

Shape: a tenant-scoped hold register naming subjects (an account, a workspace, a
business record, a date range), with the retention sweep and the erasure path
both consulting it before acting and refusing rather than skipping silently. Hold
placement and release are themselves audited. A hold suspends retention, which
means held data is exempt from G2 and G3.

Dependencies: G2 and G3, because a hold needs something to suspend. It must land
before, or with, the first customer-facing retention default, otherwise the first
litigation request has no answer.

### G5. Per-tenant data export

There is no export of any kind. No CLI command in the core capability list or in
any module's `commands.json`, no endpoint, no documented format. ADR 0004 defers
export to `audit.core`, and `modules/audit/` does not exist. The only bulk data
operation in the repository is destructive: `resetDatabase`.

Shape: a per-tenant export producing every data class the registry from G2
knows about, in a documented, versioned format, with a manifest listing classes,
row counts, and time ranges. Payload ciphertext has to be either decrypted into
the export or excluded with a stated reason, because an export of unreadable
blobs is not portability. The export runs per tenant under the tenant's
transaction context so row-level security enforces the boundary rather than
application code.

Dependencies: G2 for the data class registry. Independent of the erasure design,
and worth landing before it, since you cannot show a subject what you hold
without an export.

### G6. Erasure on request

Business records can be hard deleted today: `modules/expenses`,
`modules/parties`, and `modules/catalog` each have a `DELETE FROM ... WHERE
tenant_id = $1 AND id = $2`. That is per-record deletion by an administrator,
not subject-scoped erasure, and `archived` status in parties and catalog is a
business state rather than a retention mechanism.

The hard part is the audit trail. Erasure targets a subject's rows, which are
scattered through the chain, so it is the mid-chain deletion case: verification
breaks permanently and there is no partial verify. The design has to pick one of
three positions, and they are not equivalent.

**Option A, tombstone with a re-anchored chain.** Replace the row with a
tombstone and re-anchor the chain from that point. Rejected. Re-anchoring is
exactly the operation an attacker with write access wants: it produces a chain
that verifies over rewritten history. If the chain can be legitimately
re-anchored on request, a passing verify stops being evidence and becomes a
claim, which removes the reason the chains exist. The codebase has never done
this, even across four table versions of the agents trail.

**Option B, crypto-shred the payload and keep the hash.** Encrypt the erasable
content of an audit row under a per-subject key, keep the row and its bytes
exactly as written, and destroy the key on erasure. Verification still passes
because nothing changed. The honest limitation is that this only works if it is
designed in at write time. The hash inputs include the actor and subject
identifiers (`auditHash` over `tenantId`, `sequence`, `actorId`, `action`,
`subjectType`, `subjectId`, `metadataJson`, `occurredAt`, `previousHash` in
agents), so those fields cannot be made unreadable retroactively without
breaking the chain, and every row written before the change is not shreddable.
It also leaves a residual: the row still exists and still names the actor.

**Option C, exclude audit from erasure under a documented legal basis.** Retain
audit events as a security and contractual record, rely on the existing
minimization rule from ADR 0004, and bound their life with G2 and G3 so they age
out rather than persisting forever. Erasure then covers business records,
workflow payloads, run history, and authentication events, which is where the
personal content actually is. This is a policy answer rather than a technical
one, and it depends on the buyer accepting the basis.

**Recommendation: C now, B designed into `audit.core` for new writes, A
rejected outright.**

The reasoning is that C is available immediately, is honest, and is what most
audit trail products do; combined with G2 and G3 it converts "we keep audit
forever" into "we keep audit for a stated period under a stated basis", which
answers most of what an erasure request is actually after. B is the right
long-term shape and should be built into the `audit.core` write path when that
module lands, scoped to `metadata_json` rather than the identity columns, with
a per-subject key id on the row and `event_hash` computed over the ciphertext.
That shrinks the residual to identifiers and timestamps, which is a defensible
place to stop. A is rejected because it trades the integrity property for the
erasure property, and the integrity property is the more expensive one to
rebuild.

Whichever is chosen, the rule the workflows sweep points at applies, with the
correction noted above: record the erasure in the tamper-evident trail before
acting, and never rewrite the chain.

Shape: a subject resolution step mapping a person to rows across modules, a
per-module erasure port so each module erases what it owns rather than a central
job reaching into other modules' tables, a legal hold check before acting, an
audit event per erasure, and a certificate of what was erased.

Dependencies: G2 for the data class registry, G4 for the hold check, G5 to prove
what was held, and a decision on this section. Most dependent item here, so it
goes last among the data lifecycle items.

### G7. Key rotation as a procedure

Covered above. Rotation currently destroys data.

Shape: a keyring in the three vaults that already store a key id (agent
credentials, workflow payloads, automation secrets), with one active key for
writes and any number of retired keys accepted for reads. Their stored format
does not need to change. Then a re-encryption pass that walks rows under each
tenant, decrypts under the old key id, re-encrypts under the new one, and is
resumable and bounded like the retention sweep. Then a documented rotation
procedure with a rollback point, covering all six secrets rather than the two
that have a warning today.

The MFA key is a separate, smaller piece of work because its envelope carries no
key id and `auth_mfa_totp` has no column for one, so it needs a format and
schema change before it can join the keyring. Until then, rotating it forces
every user with TOTP enrolled to re-enroll, which is worth saying out loud in
the procedure.

Dependencies: none, and it can run in parallel with the rest. If Option B in G6
is adopted it becomes a prerequisite for that work rather than a parallel track,
since per-subject keys need a keyring first.

### G8. Access review and administrative activity reporting

The raw material exists. `auth_roles`, `auth_memberships`, and
`auth_membership_scopes` hold the grants, `auth_audit` records member,
role, scope, session, token, and settings changes, and ADR 0004's amendment
already unified reading across the platform, agents, and sandbox trails behind a
source selector. What is missing is the reporting: a point-in-time list of who
holds what, a diff between two dates, and a periodic attestation that someone
reviewed it.

Shape: a review report over the membership and scope tables, an administrative
activity report over the audit trails filtered to privileged actions, and a
recorded attestation. Export is a natural output format.

Dependencies: G5 for the export format. `access.core` from ADR 0004 owns the
richer version of this; the reporting layer can land against the current tables
without waiting for it, and should be built so it does not have to be rewritten
when `access.core` arrives.

### G9. Data residency

`infra/README.md` states that the deployment carries one database and no
per-module files, and that every module writes to PostgreSQL. That single
database is the whole residency story: residency is a property of the
deployment, not of the tenant. A deployment lives in one region, so a tenant
that requires data in a particular region needs its own deployment.

This is not necessarily a problem and it should be stated rather than
engineered around. The alternative, per-tenant routing to regional databases,
would change the provider contract in `packages/database`, the module lease
model, and every cross-tenant background scan, which is a much larger change
than anything else in this document.

Shape: document the current position, name single-tenant deployment as the
supported answer for a residency requirement, and record what a per-tenant
routing design would cost so the decision is made deliberately rather than by
accident.

Dependencies: none for the documentation. The engineering answer depends on the
provider contract and should not be started without a buyer who needs it.

## Proposed order

1. **G1, backup and recovery guidance.** No prerequisites, and it is a
   prerequisite for everything that deletes. Also the single item most likely to
   stop a deal on its own.
2. **G2, retention policy and one scheduled sweep.** The foundation. Every later
   item needs to know what is kept and for how long: erasure without it is
   manual, archival has no cutoff, legal hold has nothing to suspend, and export
   has no inventory. It also turns the two existing ad-hoc timers into instances
   of one mechanism instead of special cases.
3. **G3, audit archival and verification from an anchor.** Same sweep mechanism
   as G2 applied to the one class that cannot be deleted. Independently urgent
   for two reasons that have nothing to do with policy: verification already
   loads whole chains into memory, and tail truncation is currently undetectable.
   The anchor fixes both.
4. **G4, legal hold.** Cheap once there is one sweep to gate, and it has to exist
   before a retention default is turned on for customers.
5. **G7, key rotation.** Parallel track, no dependencies. Placed here because it
   is the item a security questionnaire raises earliest and it unblocks the
   Option B variant of G6.
6. **G5, per-tenant export.** Needs the data class registry from G2. Precedes
   erasure because you cannot demonstrate erasure without first being able to
   show what was held.
7. **G6, erasure.** Most dependencies, hardest design. Needs G2, G4, G5, and an
   accepted answer on the audit trade-off above.
8. **G8, access review reporting.** Reporting over data that already exists.
   Deliberately after the lifecycle work because it changes no storage and
   blocks nothing.
9. **G9, data residency.** Documentation now. The engineering answer should wait
   for a buyer who needs it, because per-tenant regional routing is a larger
   change than the rest of this list combined.

The ordering principle is that safety precedes policy, policy precedes
mechanism, and mechanism precedes reporting. G1 before anything that deletes.
G2 before anything that needs a cutoff. G6 last because it is the only item
that requires an irreversible design decision.

## Open questions

- Does `audit.core` from ADR 0004 land before G3, or does G3 land against the
  five existing module-local trails and get absorbed later. Building the anchor
  and verify contract five times is waste; waiting for a module that is only
  proposed is a schedule risk. The three existing verifiers have already drifted,
  which is evidence for the first option.
- Where does a chain anchor live so that truncation is detectable by someone who
  does not trust the database. Inside the same database it closes the accident
  case but not the adversary case.
- Is the retention policy per module per class, or per class across modules. Per
  module matches the settings model and module ownership. Per class is what a
  buyer's questionnaire actually asks.
- What is the default retention for each class. A default that deletes is a
  breaking change for existing deployments; a default of "keep forever" means the
  feature does nothing until configured.
- Does `auth_audit` get a hash chain, or is the platform trail permanently the
  unchained one. ADR 0004 leaves this to `audit.core`.
