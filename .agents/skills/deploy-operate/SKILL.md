---
name: deploy-operate
description: >-
  Build, configure, roll out and operate a Flowdular application: the container
  image, the production environment keys, migrations at rollout, health and
  readiness, backup and restore, and rollback.
---
# Deploy and operate

This is host work, not sandbox work. A sandbox specialist has no network, no git and no deployment.

## 1. Container build

`infra/docker/Dockerfile` is a two-stage build on `node:24-bookworm-slim`. The builder enables corepack, pins `pnpm@11.17.0`, runs `pnpm install --frozen-lockfile`, then `pnpm verify && pnpm build`, so a failing gate fails the image. The runtime stage copies only `platform/dist` and `platform/package.json`, runs as the non-root user `octane` (uid 1001), exposes 3000, declares the `/data` volume and starts `node platform/dist/server/entry.js`. Its `HEALTHCHECK` polls `/api/health`.

```bash
docker compose -f infra/docker/compose.yaml up --build   # local stack: postgres-tls, postgres 17 with ssl=on, app
```

The compose `app` service runs `read_only: true` with a `tmpfs` on `/tmp` and publishes `${FD_PORT:-3000}`. Tagging `v*.*.*` (or running the workflow by hand) builds and pushes the same Dockerfile to `ghcr.io/<repository>` through `.github/workflows/container.yml`. Kubernetes manifests live in `infra/kubernetes` and apply with `kubectl apply -k infra/kubernetes`; the secrets they expect have examples in the same directory. `infra/README.md` carries the local and cluster walkthrough.

## 2. Production environment

`docs/configuration.md` is the reference. The keys a production deployment must set:

| Key                             | Why                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`           | Turns on every production refusal below; `FD_ENV=production` only gates the CLI local-only commands |
| `FD_DATABASE_ADAPTER`           | Must not be `pglite`; production refuses the embedded adapter                                       |
| `FD_DATABASE_URL`               | Runtime role, neither `SUPERUSER` nor `BYPASSRLS`                                                   |
| `FD_DATABASE_MIGRATOR_URL`      | Separate DDL role; required in production                                                           |
| `FD_DATABASE_TLS=verify-full`   | The only value production accepts, with `FD_DATABASE_TLS_CA[_FILE]`                                 |
| `FD_AUTH_PUBLIC_ORIGIN`         | Same-origin checks and cookie scope                                                                 |
| `FD_AUTH_SECURE_COOKIE`         | `Secure` and the `__Host-` cookie prefix; defaults on in production                                 |
| `FD_AUTH_MFA_KEY`               | Decrypts stored MFA secrets                                                                         |
| `FD_AGENT_CREDENTIAL_KEY`       | `agents.core` refuses to boot without it                                                            |
| `FD_AGENT_RUN_GRANT_KEY`        | `agents.core` refuses to boot without it                                                            |
| `FD_WORKFLOWS_PAYLOAD_KEY`      | `workflows.core` refuses to boot without it                                                         |
| `FD_WORKFLOWS_CURSOR_KEY`       | `workflows.core` refuses to boot without it                                                         |
| `FD_AUTOMATIONS_CREDENTIAL_KEY` | `automations.core` refuses to boot without it                                                       |
| `FD_NOTIFICATIONS_SECRET_KEY`   | `notifications.core` refuses to boot without it                                                     |
| `FD_CONNECTORS_SECRET_KEY`      | `connectors.core` refuses to boot without it                                                        |
| `FD_AUDIT_ANCHOR_KEY`           | `audit.core` refuses to seal or verify without it in production                                     |

Every key above is base64 of 32 random bytes where it names a key. `FD_AUTOMATIONS_CREDENTIAL_KEY` is read by `modules/automations/src/services/secret-vault.ts`, which throws `FD_AUTOMATIONS_CREDENTIAL_KEY is required in production.`; in development it generates and persists a local key file instead, so a deployment that never set it fails only at the production boot. Set it whenever `automations.core` is enabled in `flowdular.json`.

Set `FD_TRUST_PROXY` behind a load balancer. `FD_DATABASE_BACKGROUND_URL` gives worker traffic its own pool. Everything else in `docs/configuration.md` has a working default.

## 3. Migrations at rollout

Migrations are module-owned, numbered, immutable once applied, and verified by checksum against the `_coreloom_migrations_v2` ledger. The commands (`packages/cli/src/runner.ts`):

```bash
pnpm flowdular migration status [--module <id>]      # what the ledger holds
pnpm flowdular migration verify                      # checksums against the shipped SQL
pnpm flowdular migration apply --module <id>         # dry run, one module at a time
pnpm flowdular migration apply --module <id> --apply # writes
```

`migration apply` carries the `migration.apply.local` capability, which is `localOnly`: the runner refuses it with `LOCAL_ONLY_CAPABILITY` unless `FD_ENV` or `NODE_ENV` is `development` or `test`. It is therefore a local and staging tool as the code stands, not a production rollout step. In production the application applies its own module migrations at boot under a migration lease using `FD_DATABASE_MIGRATOR_URL`, so the rollout order is: apply the new image, let it migrate, then verify. A new module needs `pnpm flowdular module enable <id> --apply` (which grants its scopes) in the workspace before the image is built.

Never edit an applied `.up.sql`, not even whitespace: the checksum changes and the next boot refuses to start.

## 4. Health and readiness

- `GET /api/health` is public and static. It proves the process is up and nothing else. Use it as the liveness probe.
- `GET /api/ready` is public and calls the database provider: it checks the runtime and background roles are neither superuser nor `BYPASSRLS`, then runs a statement on the migrator pool. It answers 503 with `retry-after: 1` when the database is unavailable. Use it as the readiness probe.

Both are served by `platform/src/server/health.ts`. The shipped Docker and Kubernetes probes all point at `/api/health`; moving the readiness probe to `/api/ready` is the improvement worth making. Before the database is configured the application runs in setup mode and `/api/ready` is not routed at all, so a first-run container answers 404 there rather than 503.

## 5. Backup, restore, and the key trap

`docs/operations.md` is the runbook. Read it before touching production data; this skill does not restate it. The commands:

```bash
pnpm flowdular database backup --output <dir>                            # dry run
pnpm flowdular database backup --output <dir> --apply
pnpm flowdular database restore --input <dir> --apply --confirm restore-database
```

The trap: **the encryption keys live outside the database.** Agent provider credentials, agent run grants, workflow payloads and cursors, automation secrets and MFA secrets are all stored as ciphertext, and the keys are environment variables (`FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`, `FD_WORKFLOWS_PAYLOAD_KEY`, `FD_WORKFLOWS_CURSOR_KEY`, `FD_AUTOMATIONS_CREDENTIAL_KEY`, `FD_AUTH_MFA_KEY`, `FD_NOTIFICATIONS_SECRET_KEY`, `FD_STORAGE_ENCRYPTION_KEY`, `FD_CONNECTORS_SECRET_KEY`, `FD_AUDIT_ANCHOR_KEY`). A database backup without the matching keys restores rows nobody can read, and rotating a key without re-encrypting orphans everything encrypted under the old one. Back the keys up separately, restore them together with the dump, and record which key version a dump belongs to.

## 6. Rollback

1. Redeploy the previous image tag. Module migrations are additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`), so an older image runs against a newer schema; it ignores columns it does not know.
2. Never run a `.down.sql` to roll back a release. They document the reverse for review, and applying one against live data is data loss.
3. To take one module out of service without a redeploy: `pnpm flowdular module disable <id> --apply` (it is a dry run without `--apply`), then rebuild the composition and redeploy. Its tables stay.
4. If the rollback is because of a key change, restore the previous key first; the image alone will not fix unreadable ciphertext.

## 7. Production checklist

- `pnpm verify` and `pnpm build` pass on the commit being shipped (the image build runs both).
- `NODE_ENV=production`, a PostgreSQL adapter, `FD_DATABASE_TLS=verify-full` with its CA.
- Runtime role has neither `SUPERUSER` nor `BYPASSRLS`; the migrator role is separate.
- Every encryption key set, stored outside the database, and backed up with a recorded version.
- `FD_AUTOMATIONS_CREDENTIAL_KEY` set whenever `automations.core` is enabled in `flowdular.json`, `FD_NOTIFICATIONS_SECRET_KEY` whenever `notifications.core` is, `FD_CONNECTORS_SECRET_KEY` whenever `connectors.core` is, and `FD_AUDIT_ANCHOR_KEY` whenever `audit.core` is.
- `FD_AUTH_PUBLIC_ORIGIN` matches the public URL; `FD_AUTH_SECURE_COOKIE` on; `FD_TRUST_PROXY` set behind a proxy.
- Sign-up closed (`FD_AUTH_ALLOW_SIGN_UP`) unless the deployment is public; the first owner created with `flowdular auth workspace-create` (see `docs/cli.md`).
- Liveness on `/api/health`, readiness on `/api/ready`.
- `pnpm flowdular migration verify` clean after rollout, and `pnpm flowdular doctor --json` reports `status: healthy`.
- A restore has been rehearsed once, keys included.

## Pitfalls

- `setup quick` and `auth greenfield` are local resets that wipe auth data. They refuse outside `development` and `test`; never point them at a deployment.
- `pglite` is the local and test adapter. A production boot with it is refused, not degraded.
- A module added to the workspace but not enabled is absent from the built image: `module enable` writes the generated composition, and `pnpm build` bakes it in.
- Scopes for a new permission reach existing owners only after `flowdular auth sync-scopes --module <id> --apply`; an endpoint can be live while every user gets 403.
- Rotating `FD_AUTH_MFA_KEY` locks out every enrolled user, not just new enrolments.
