---
title: Environment Configuration
subtitle: How a Flowdular deployment is configured, which values are mandatory before production accepts a boot, and the order in which an environment is brought up.
eyebrow: Operations Handbook
docId: FD-OPS-001
version: 1.0
status: Draft
owner: Platform Engineering
audience: Operators, platform engineers
date: 2026-09-22
nextReview: 2027-03-22
classification: Internal
---

## Purpose and scope

This document describes how a Flowdular deployment is configured and what an
operator must decide before a production environment will start. It covers the
platform runtime, the database, the encryption keys, object storage, mail and
observability.

It is a working document, not a reference. Every variable, default and bound is
listed in `docs/configuration.md`; when the two disagree, the reference wins and
this document is wrong.

> [!note] Design principle
> Every option has a development default, so a fresh checkout runs with no
> configuration at all. Production is the opposite: the platform refuses to boot
> rather than start with a weak default. Every refusal names the variable that
> caused it.

### Audience

Readers are expected to be comfortable with PostgreSQL roles, TLS material and
container environment files. No knowledge of the module system is assumed.

### Naming

Every runtime option is an environment variable prefixed `FD_`. A handful of
mail options carry an older `FD_AUTH_` spelling; both are read, the platform
name wins when both are set, and the server logs one deprecation line naming the
replacement.

<!-- page -->

## Environments

Four environments matter, and they differ by what the platform refuses rather
than by what it offers.

| Environment | Database           | Object storage | Keys               | Sign-up |
| ----------- | ------------------ | -------------- | ------------------ | ------- |
| Local       | PGlite, embedded   | Local files    | Generated per boot | Open    |
| CI          | PostgreSQL service | Local files    | Generated per boot | Open    |
| Staging     | PostgreSQL         | S3 compatible  | Set, separate set  | Closed  |
| Production  | PostgreSQL         | S3 compatible  | Set, rotated       | Closed  |

`FD_ENV` decides which set of guards applies, falling back to `NODE_ENV` and
then to `development`. Production refuses the embedded database, refuses the
local object store, refuses a development mail transport and refuses every
generated key.

> [!warning] Staging is not a relaxed production
> Staging must hold its own keys, its own database roles and its own object
> store. Sharing any of the three with production means a staging incident is a
> production incident.

## Database

Flowdular runs on PostgreSQL. One platform-owned provider serves every module,
so there is one database and no per-module option. Outside production the
adapter is PGlite, the same engine embedded in the process, which is why a local
checkout needs no server.

### Roles

Three login roles are required, and none of them may hold `SUPERUSER` or
`BYPASSRLS`. Row-level security is the tenant boundary, and a role that bypasses
it turns every isolation test into a test of nothing.

| Role       | Variable                     | Purpose                                  |
| ---------- | ---------------------------- | ---------------------------------------- |
| Migrator   | `FD_DATABASE_MIGRATOR_URL`   | Owns the schema, holds DDL leases        |
| Runtime    | `FD_DATABASE_URL`            | Serves requests under a tenant predicate |
| Background | `FD_DATABASE_BACKGROUND_URL` | Cross-tenant read-only work              |

Production refuses a shared runtime and migrator DSN. Without a background DSN
a `background` lease is refused rather than quietly served by the runtime role.

```bash
psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE flowdular_migrator LOGIN PASSWORD :'migrator' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE flowdular_runtime LOGIN PASSWORD :'runtime' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE flowdular_background LOGIN PASSWORD :'background' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE flowdular OWNER flowdular_migrator;
SQL
```

After the database exists, grant connect to the runtime and background roles and
revoke the default public schema grant, so a new role starts with nothing.

### Transport security

`FD_DATABASE_TLS` defaults to `verify-full` and production allows nothing
weaker. Supply the certificate authority either inline as `FD_DATABASE_TLS_CA`
or from a mounted file as `FD_DATABASE_TLS_CA_FILE`, never both.

### Timeouts

The four timeout values are ordered, and the platform enforces the ordering:
the lock timeout is never longer than the statement timeout, and the driver
query timeout is never shorter than it. Raise them together or not at all.

<!-- page -->

## Keys and secrets

Every key is a base64 encoded 32-byte value. Generate one per key, per
environment:

```bash
openssl rand -base64 32
```

These keys are required in production and the owning module refuses to boot
without them:

| Key                             | Protects                         | Loss means                             |
| ------------------------------- | -------------------------------- | -------------------------------------- |
| `FD_AUTH_MFA_KEY`               | Stored MFA secrets               | Every enrolled factor is unreadable    |
| `FD_AGENT_CREDENTIAL_KEY`       | Model provider credentials       | Stored provider credentials are lost   |
| `FD_AGENT_RUN_GRANT_KEY`        | Run grant signatures             | Issued grants stop verifying           |
| `FD_AUTOMATIONS_CREDENTIAL_KEY` | Automation credentials           | Stored automation credentials are lost |
| `FD_NOTIFICATIONS_SECRET_KEY`   | Webhook signing secrets          | Subscribers must re-enrol              |
| `FD_CONNECTORS_SECRET_KEY`      | Connector credentials            | Every connector must be reconnected    |
| `FD_WORKFLOWS_PAYLOAD_KEY`      | Workflow run payloads            | Historic run payloads are unreadable   |
| `FD_WORKFLOWS_CURSOR_KEY`       | Execution cursors                | In-flight runs cannot resume           |
| `FD_STORAGE_ENCRYPTION_KEY`     | Every stored object and read URL | Every stored object is unreadable      |
| `FD_AUDIT_ANCHOR_KEY`           | Audit chain anchors              | Sealed segments cannot be proven       |

> [!danger] These keys are not recoverable
> There is no escrow and no recovery path. A lost key means the data it sealed
> is gone. Store every key in the same secret manager that holds the database
> passwords, and back it up before the first production boot, not after.

### Rotation

Each key has a `_PREVIOUS` companion that holds retired values as a comma
separated list. The pattern is the same everywhere: move the retiring key into
the `_PREVIOUS` list, put the new key in the current variable, boot, then run
the module's re-seal command so stored material moves to the new key. Sealed
data keeps opening throughout, so rotation needs no downtime window. The exact
commands are in `docs/operations.md`, section Key rotation.

## Object storage

Attachments, documents and images live outside PostgreSQL, so tenant isolation
there is the key layout rather than row-level security. Every key is
`<tenantId>/<moduleId>/<objectId>`, the tenant id comes from the authenticated
principal, and every object is encrypted with AES-256-GCM with its metadata
authenticated alongside it. An object moved into another tenant's prefix does
not open.

Production requires the `s3` adapter and refuses `local`. Any S3 compatible
store works; set `FD_STORAGE_S3_ENDPOINT` for MinIO, R2 or another provider, and
`FD_STORAGE_S3_FORCE_PATH_STYLE` when the store does not do bucket subdomains.

The per-object ceiling is `FD_STORAGE_MAX_OBJECT_BYTES`, 25 MiB by default. Only
a fixed content type list is accepted and the bytes are verified against the
declared type, so an archive renamed to `.xlsx` is refused.

## Mail

One outbound transport serves the whole deployment; modules never select one.
Production accepts only `FD_MAIL_TRANSPORT=smtp` and requires
`FD_MAIL_SMTP_URL` and `FD_MAIL_FROM` with it. The `development` transport is
in-memory and refused in production, and `none` refuses every message with
`MAIL_NOT_CONFIGURED`.

Leave `FD_MAIL_SMTP_REQUIRE_TLS` and `FD_MAIL_SMTP_TLS_REJECT_UNAUTHORIZED` at
their defaults. Turning either off allows a plaintext or unverified session to
the relay.

<!-- page -->

## Observability

Spans are always recorded into a bounded in-process buffer and the logger always
writes the trace id. Only the two egresses are optional, and a misconfigured one
fails the boot rather than silently sending nothing.

- Traces: `FD_TRACE_EXPORTER=otlp` with `FD_TRACE_OTLP_URL`, https in
  production. `FD_TRACE_SAMPLE` sets the root trace ratio.
- Errors: `FD_ERROR_SINK=webhook` with `FD_ERROR_SINK_URL`, https in
  production, and `FD_ERROR_SINK_TOKEN` as the bearer credential.
- Metrics: `FD_METRICS=true` exposes `GET /api/metrics`, and
  `FD_METRICS_TOKEN` is the bearer token a scrape must present.

Set `FD_LOG_FORMAT=json` in production so one log line is one object.

## What is not an environment variable

The product name, document title, description, link preview image, browser
icon, theme colour and logo are `system.core` settings, changed under
Administration, Branding by an owner with `system.settings.manage`, and every
change is audited. One value serves the whole deployment, including the sign-in
screen and shared links.

An address is stored only as a path on the deployment or an https URL;
`javascript:`, `data:` and protocol-relative values are refused on write. Every
https branding image origin is added to the `img-src` of the policy the
deployment serves.

## Bring-up checklist

Run in order. Each step assumes the previous one succeeded.

1. Provision the database, the three roles and the TLS authority. Confirm the
   runtime role holds neither `SUPERUSER` nor `BYPASSRLS`.
2. Generate every key in the table above, one per environment, and store them in
   the secret manager. Back them up.
3. Copy `infra/docker/.env.example` to `infra/docker/.env` and fill every empty
   value: the keys, the object store settings and the four PostgreSQL role
   passwords.
4. Provision the object store bucket and its credentials.
5. Configure the mail relay and send one test message.
6. Point the observability egresses at the collector.
7. Roll out. Migrations run at rollout under the migrator role.
8. Verify, as below.

## Verification

- `GET /api/health` answers for liveness. Wire it to the liveness probe.
- `GET /api/ready` reports the adapter and answers 503 while the database is
  unreachable. Wire it to the readiness probe.
- `pnpm flowdular doctor` reports configuration checks, including
  `platform.branding` for an application scaffolded before the branding release.
- `flowdular migration verify` confirms the applied ledger matches the shipped
  migrations.

> [!success] A deployment is configured correctly when
> it boots without a refusal, `/api/ready` reports the `postgresql` adapter,
> `migration verify` is clean, and a tenant isolation probe from one workspace
> returns no row belonging to another.

## Change control

Configuration changes follow the same path as code. A changed key, a changed
DSN or a changed bound is a pull request against the environment definition, not
an edit on a running host. Key rotation is the one procedure that touches a
running deployment, and it is logged in the audit chain like any other
administrative act.

Deprecated variable names are read for one release cycle and logged at every
boot. Treat a deprecation line in the startup log as work, not noise: the
fallback is removed in a later release and the boot then refuses.
