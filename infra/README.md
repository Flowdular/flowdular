# Deployment

The production artifact is the Octane fullstack server built from `platform`. It runs as a non-root user and exposes `GET /api/health` for container and orchestrator probes.

## Deployment targets

`pnpm flowdular deploy targets` lists the runtime contract for each target.
`pnpm flowdular deploy plan <target> --json` returns checks without changing the
workspace or contacting a provider. `pnpm flowdular deploy start docker --apply`
uses the existing local launcher after a preflight. It prints the one-time setup
token, so it requires a private interactive terminal and refuses `--json` or
redirected output. Omitting `--apply` returns the plan. `--no-open` and
`--no-build` pass through to the launcher. The launcher records a bounded,
credential-free receipt in `.flowdular/deployments.json`. A concurrent start
is refused by its lock. If a process crashes and leaves
`.flowdular/deployment.lock`, verify no deployment is running before removing
that lock.

The [Render Blueprint](../render.yaml) is a remote persistent-process adapter.
Connect the repository as a Blueprint after provisioning PostgreSQL with
separate runtime, background and migrator roles, verified TLS and external S3
storage. Render prompts for the database URLs, CA and storage credentials,
derives the public HTTPS origin from its web service, and generates the
encryption keys on first creation. Export and back up those keys alongside
database and object backups. The Blueprint uses a paid always-on web plan,
builds the existing Dockerfile, disables automatic deploys
and uses `/api/health` because `/api/ready` is not routed during first-run
setup. Check `/api/ready` after setup before directing production traffic.
Blueprint sync does not re-prompt for newly added `sync: false` secrets, so add
them in Render before syncing an existing deployment. The database and object
store are not created by this Blueprint. After committing `render.yaml` and
`infra/docker/Dockerfile` and pushing the current branch to `origin`,
`deploy plan render --json` includes a Deploy to Render URL if both files pass
Flowdular's structural checks, match the pushed branch and the origin is a
credential-free HTTPS or SSH GitHub, GitLab or Bitbucket remote. The URL selects that branch explicitly,
including before a feature branch is merged into the default branch. Local
tracking refs are checked without contacting the Git provider, so confirm that
the branch still exists and is accessible in Render. Flowdular's check does
not replace Render's full Blueprint validation. The URL opens the Blueprint
review and does not bypass external service and secret configuration. Render
documents this [button flow](https://render.com/docs/deploy-to-render).
If you add a custom domain, change `FD_AUTH_PUBLIC_ORIGIN` in your Blueprint to
that HTTPS origin before sending users there. A later Blueprint sync can
replace a value changed only in the Render service.

This Blueprint does not create Render Postgres. Render Blueprints can create a
database, but each definition exposes one user and `fromDatabase` supplies its
internal URL. Flowdular requires separate runtime and migrator credentials;
Render's internal PostgreSQL connection has a self-signed certificate and
[does not support `verify-full`](https://render.com/docs/postgresql-creating-connecting)
while Flowdular requires that mode in production. Referencing the same URL for
both roles would also fail Flowdular's credential separation check. A database
with the required roles and verified TLS must therefore be prepared before
using this Blueprint. Render's [Blueprint reference](https://render.com/docs/blueprint-spec)
documents the available database fields and references. Its
[credential guide](https://render.com/docs/postgresql-credentials) explains
that additional users are managed outside the Blueprint.

The Blueprint defaults to AWS S3 for the supplied region. It does not create a
bucket. To use another S3-compatible store, also set
`FD_STORAGE_S3_ENDPOINT` in the Render service and
`FD_STORAGE_S3_FORCE_PATH_STYLE=true` when that store requires path-style
requests. Render can host [MinIO with a persistent disk](https://render.com/docs/deploy-minio),
but a complete Flowdular Blueprint would still need a pinned MinIO image,
private networking, bucket initialization, credential wiring, backup recovery
and provider-level tests. Render disk snapshots are documented
[here](https://render.com/docs/disks).

The smallest path to a one-action deployment is a provider adapter that
provisions a database, creates the separated roles under a migration-only
credential, verifies a trusted TLS connection, provisions an S3-compatible
bucket, and binds the resulting secrets without logging them. It must then
exercise first-run setup, migration failure, restart and restore against a
real Render account before the deploy action can be called one click.

The [Vercel artifact](vercel/README.md) packages Octane's Node handler and
client assets through the Build Output API as a web Function and a worker
Function. [Vercel Functions scale down to zero](https://vercel.com/docs/functions),
so module workers run only inside ticks: Vercel Cron ticks the worker Function
every minute, and a state-changing request ticks it at once. `deploy plan vercel
--json` checks the source files and returns a Vercel import URL for a pushed
branch. `deploy start vercel --apply` provisions Neon PostgreSQL, a private Blob
store and the stable keys through the Vercel CLI, deploys to Production and
prints a one-time token for creating the first workspace at `/setup`; the import
URL needs them set up by hand.

Cloudflare is still unavailable as a full target. Its Durable Object
[Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
supports explicit lifecycle control, but this repository has no verified
restart, secret or rollout adapter for it.

## Local container

```bash
node infra/docker/start.mjs
```

This requires Node and Docker Compose. On the first run, the launcher creates
`infra/docker/.env` with owner-only permissions, generates independent PostgreSQL
passwords and encryption keys, and keeps them on later runs. It starts
PostgreSQL, MinIO with a private bucket, and the app, then opens the setup page
in a browser on this workstation. The setup token is printed by the app and
shown by the launcher. `--no-open` leaves the browser alone, and `--no-build`
reuses an image already built. A headless host prints the URL instead.
Each new installation gets a persistent `COMPOSE_PROJECT_NAME` in `.env`, so
separate apps have separate database and object volumes. An older `.env` keeps
Compose's former `docker` project name and its existing volumes.
If an older `.env` sets `FD_AUTH_SECURE_COOKIE=true` for `http://localhost`,
the launcher asks you to change that value to `false` or use HTTPS before it
starts the stack.

The database and object store are already connected in the wizard, so setup
starts with the workspace and owner. When setup finishes, Compose restarts the
app into the sign-in screen. The normal local address is
`http://localhost:3000`; set `FD_PORT` to change it. The port binds only to
`127.0.0.1` by default. A TLS reverse proxy on another host needs an explicit
IPv4 `FD_BIND_ADDRESS`, `FD_AUTH_PUBLIC_ORIGIN`, and `FD_AUTH_SECURE_COOKIE=true`.

To use Compose without the launcher, copy `infra/docker/.env.example` to
`infra/docker/.env`, fill every required secret, set
`COMPOSE_PROJECT_NAME` uniquely for this app and
`FD_AUTH_SECURE_COOKIE=false` for local HTTP, then run
`docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml up --build`. Compose refuses
missing secrets. The setup URL and one-time token appear in the `app` container
logs (`docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml logs app`). Do not put the
token in a URL or share the logs. Production deployments should supply managed
secrets and TLS.

Outgoing mail is off until it is configured: with `FD_AUTH_MAIL_TRANSPORT=none` a
workspace invitation is refused and a password reset is never delivered. Set
`FD_AUTH_MAIL_TRANSPORT=smtp` with `FD_AUTH_SMTP_URL` (an `smtp://` or `smtps://`
relay URL carrying the relay password, so keep it in `.env` or the Secret, never
in the manifest) and `FD_AUTH_MAIL_FROM`. In Kubernetes the URL comes from the
optional `smtpUrl` entry of the `flowdular-agents` Secret.

Compose also starts PostgreSQL. A one-shot `postgres-tls` service generates a
self-signed server certificate for `CN=postgres` on first run, Postgres serves
TLS with it, and the app verifies it through `FD_DATABASE_TLS_CA_FILE` under
`verify-full`. First cluster initialization creates three roles: `flowdular_migrator`
owns the schema, `flowdular_runtime` holds neither `SUPERUSER` nor `BYPASSRLS`, so
the row-level security tenant tables force actually binds the application, and
`flowdular_background` serves the cross-tenant scheduler poll with no default
table grant at all. The launcher creates the four PostgreSQL passwords in
`infra/docker/.env`. Existing passwords are never rotated or replaced. If the
PostgreSQL volume already exists, use the passwords that initialized it or
change the roles in PostgreSQL deliberately before changing the file.

A volume initialized by Flowdular 0.5 or earlier holds the roles under their
old names, and the role script never runs again on an existing volume, so the
app fails to sign in as `flowdular_runtime`. Flowdular 0.6 does not upgrade
that database. Remove the volume, which deletes its data, with
`docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml down -v`
and start again.

The launcher creates `infra/docker/.env.lock` only while preparing the secret
file, so parallel starts cannot save different credentials. If a launcher
crashes and leaves the lock, verify that no other launcher is running before
removing it. An existing AWS S3 configuration with an empty endpoint keeps that
endpoint; only a new local installation receives the MinIO address.

Every module reads and writes through the platform database provider, so the
deployment carries one database and no per-module files. Public sign-up is
disabled by default. The local launcher sets an HTTP-compatible session cookie;
manual or remote deployments should set the cookie flag for their origin.

The MinIO objects live in the `flowdular-objects` volume. Back up that volume,
the PostgreSQL data and WAL volumes, and `infra/docker/.env` together. The file
contains keys needed to decrypt records and objects after restore. A database
dump alone does not restore the object bytes or encryption keys. Re-running the
launcher preserves existing volumes and values; deleting `.env` and generating
new keys against an old database will make encrypted content unreadable.

The runtime image contains `platform/dist`, `platform/package.json`, and a small
entrypoint that URL-encodes PostgreSQL passwords before starting the server.
Its only `node_modules` content, in an application built on `@flowdular/sdk`, is
the SDK's module index with the `module.json` and `spec/module.yaml` of each
module it lists, and a `package.json` exporting that index. The platform reads
them to list its modules.

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
  --from-literal=migratorUrl='postgresql://flowdular_migrator:...@postgres:5432/flowdular' \
  --from-literal=runtimeUrl='postgresql://flowdular_runtime:...@postgres:5432/flowdular' \
  --from-literal=backgroundUrl='postgresql://flowdular_background:...@postgres:5432/flowdular'
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
compose --env-file infra/docker/.env -f infra/docker/compose.yaml cp postgres:/var/lib/postgresql/wal-archive <dir>`, or a sync job on
  the volume) on the schedule the data policy sets.
- It never prunes. When the copy fails (a full volume, wrong permissions),
  PostgreSQL retries forever and `pg_wal` grows until the disk is full; watch
  `docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml logs postgres` for `archive command failed`. Prune segments
  older than the oldest base backup you keep with
  `docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml exec -u postgres postgres pg_archivecleanup /var/lib/postgresql/wal-archive <name>.backup`,
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

After the restore: `docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml up -d app`, then `pnpm flowdular migration verify`
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
