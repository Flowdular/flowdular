# Deployment

The production artifact is the Octane fullstack server built from `platform`. It runs as a non-root user and exposes `GET /api/health` for container and orchestrator probes.

## Local container

```bash
docker compose -f infra/docker/compose.yaml up --build
```

Before the first start, copy `infra/docker/.env.example` to `infra/docker/.env` and fill in `FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`, `FD_AUTOMATIONS_CREDENTIAL_KEY`, `FD_NOTIFICATIONS_SECRET_KEY`, `FD_WORKFLOWS_PAYLOAD_KEY`, `FD_WORKFLOWS_CURSOR_KEY`, `FD_STORAGE_ENCRYPTION_KEY`, `FD_CONNECTORS_SECRET_KEY` and `FD_AUDIT_ANCHOR_KEY` (`openssl rand -base64 32` each). Compose refuses to start without them. The owning modules also refuse to boot in production without them, so a missing key fails at startup rather than during the first run.

Outgoing mail is off until it is configured: with `FD_AUTH_MAIL_TRANSPORT=none` a
workspace invitation is refused and a password reset is never delivered. Set
`FD_AUTH_MAIL_TRANSPORT=smtp` with `FD_AUTH_SMTP_URL` (an `smtp://` or `smtps://`
relay URL carrying the relay password, so keep it in `.env` or the Secret, never
in the manifest) and `FD_AUTH_MAIL_FROM`. In Kubernetes the URL comes from the
optional `smtpUrl` entry of the `flowdular-agents` Secret.

The service is available on `http://localhost:3000`. Set `FD_PORT` to change the host port.

Compose also starts PostgreSQL. A one-shot `postgres-tls` service generates a
self-signed server certificate for `CN=postgres` on first run, Postgres serves
TLS with it, and the app verifies it through `FD_DATABASE_TLS_CA_FILE` under
`verify-full`. First cluster initialization creates three roles: `coreloom_migrator`
owns the schema, `coreloom_runtime` holds neither `SUPERUSER` nor `BYPASSRLS`, so
the row-level security tenant tables force actually binds the application, and
`coreloom_background` serves the cross-tenant scheduler poll with no default
table grant at all. Set `FD_POSTGRES_SUPERUSER_PASSWORD`,
`FD_DATABASE_MIGRATOR_PASSWORD`, `FD_DATABASE_RUNTIME_PASSWORD`, and
`FD_DATABASE_BACKGROUND_PASSWORD` in `infra/docker/.env`.

Every module reads and writes through the platform database provider, so the
deployment carries one database and no per-module files. Public sign-up is disabled by default. The session cookie is Secure (`__Host-` prefix) by default because the container expects TLS in front of it. For a plain-HTTP run on a workstation set `FD_AUTH_SECURE_COOKIE=false` in `infra/docker/.env`; do not do this for anything reachable from a network.

The runtime image contains only `platform/dist` and `platform/package.json`. The server bundle imports node built-ins exclusively, so no `node_modules` directory ships with it.

## Published image

Tagging a release such as `v0.1.0`, or manually running the `Publish container` workflow, builds and publishes `ghcr.io/<owner>/<repository>`. Update the image name in `infra/kubernetes/kustomization.yaml` before applying it.

```bash
kubectl create secret generic flowdular-agents \
  --from-literal=credentialKey="$(openssl rand -base64 32)" \
  --from-literal=runGrantKey="$(openssl rand -base64 32)" \
  --from-literal=automationsCredentialKey="$(openssl rand -base64 32)" \
  --from-literal=notificationsSecretKey="$(openssl rand -base64 32)" \
  --from-literal=workflowsPayloadKey="$(openssl rand -base64 32)" \
  --from-literal=workflowsCursorKey="$(openssl rand -base64 32)"
kubectl apply -k infra/kubernetes
```

The Deployment reads all six keys from the `flowdular-agents` Secret. `agents-secret.example.yaml` shows its shape with placeholders and is deliberately not part of the kustomization. Rotating `credentialKey` invalidates every stored provider credential; re-enter them under Providers afterwards. Rotating `workflowsPayloadKey` makes retained workflow execution payloads unreadable, so drain runs and let retention remove payloads before rotating it.

The Kubernetes base carries no volume for application data: the deployment is stateless and every module writes to PostgreSQL. Create the `flowdular-database` Secret with the three connection strings before applying it; `database-secret.example.yaml` shows its shape with placeholders and is deliberately not part of the kustomization.

```bash
kubectl create secret generic flowdular-database \
  --from-literal=migratorUrl='postgresql://coreloom_migrator:...@postgres:5432/flowdular' \
  --from-literal=runtimeUrl='postgresql://coreloom_runtime:...@postgres:5432/flowdular' \
  --from-literal=backgroundUrl='postgresql://coreloom_background:...@postgres:5432/flowdular'
```

Scaling writers across nodes needs nothing beyond the database it already shares.

## Backups and PITR

Logical backups are `flowdular database backup` and the restore commands in
[docs/operations.md](../docs/operations.md); they restore a whole dump and
nothing in between two dumps. Point-in-time recovery (PITR) fills that gap for
the compose stack: the `postgres` service runs with `wal_level=replica`,
`archive_mode=on` and an `archive_command` that copies every completed WAL
segment into the `flowdular-postgres-wal` volume (`archive_timeout=300`, so a
quiet database still ships a segment every five minutes). A base backup plus
the archive can then be replayed to any moment after the base backup.

What the plain `cp` archive does not do, and what to add before relying on it:

- It does not `fsync` the copy, so a host crash can lose the last segments;
  the copy is only as durable as the volume it lands on.
- It writes to the same host as the data directory. A disk that takes the data
  volume takes the archive with it. Copy the archive off the host (`docker
compose cp postgres:/var/lib/postgresql/wal-archive <dir>`, or a sync job on
  the volume) on the schedule the data policy sets.
- It never prunes. When the copy fails (a full volume, wrong permissions),
  PostgreSQL retries forever and `pg_wal` grows until the disk is full; watch
  `docker compose logs postgres` for `archive command failed`. Prune segments
  older than the oldest base backup you keep with
  `docker compose exec -u postgres postgres pg_archivecleanup /var/lib/postgresql/wal-archive <name>.backup`,
  where `<name>.backup` is the history file the archive received when that base
  backup finished.
- It is neither compressed nor encrypted. The archive holds every row of every
  tenant in the clear; the volume is mode 0700 and the copy off the host must
  be treated like a dump.

`infra/docker/pitr.sh` wraps the two steps:

```bash
infra/docker/pitr.sh base-backup            # pg_basebackup -Ft -z -X fetch into base/<stamp>
infra/docker/pitr.sh list                   # the base backups the archive holds
infra/docker/pitr.sh restore --base <stamp> --target-time '2026-09-14 09:30:00+00' \
  --confirm replace-cluster [--stop-app]
```

`base-backup` runs `pg_basebackup` from the same `postgres:17` image over the
container socket while the database serves, and writes the tarball into the
archive volume under `base/<stamp>`. Take one after every rollout and at least
weekly; the archive between two base backups is what a restore replays, so the
older the base, the longer the replay.

`restore` refuses while the `app` container is running unless `--stop-app` is
passed, because the app would keep serving a cluster that is about to be
deleted. It then stops `postgres`, deletes the current data directory (there is
no undo: take a `base-backup` first if the current cluster may still be
needed), unpacks the base backup, appends `restore_command`,
`recovery_target_time` and `recovery_target_action = 'promote'` to
`postgresql.conf`, creates `recovery.signal` and starts `postgres` again. It
waits for `pg_is_in_recovery()` to turn false, which is the promotion. Without
`--target-time` the archive is replayed to its end. A target time earlier than
the end of the base backup makes PostgreSQL stop with `recovery ended before
configured recovery target was reached`; pick an older base. After promotion
the server is on a new timeline and archives onto it, so the segments of the
old timeline stay in the archive and a second restore to the same base is still
possible.

After the restore: `docker compose up -d app`, then `pnpm flowdular migration verify`
and `GET /api/ready`. The encryption keys are outside the database and PITR
changes nothing about them: the keys the restored rows were written under must
be the ones in `infra/docker/.env`.

**Kubernetes.** The base carries no PostgreSQL workload, and none is planned:
the connection strings in the `flowdular-database` Secret point at a server the
managed provider runs, and PITR is that provider's job. The provider has to
offer, and the deployment has to turn on: continuous WAL archiving to storage
outside the database host, scheduled base backups with a retention that covers
the recovery window the business needs, a restore that accepts a recovery
target (a timestamp, at minimum) and lands on a new instance or a new database
so the current one can be kept for comparison, and a record of the backup and
restore runs the operator can read. The `flowdular database backup` dump remains
the portable copy that leaves the provider; take it on the runbook's schedule
regardless.
