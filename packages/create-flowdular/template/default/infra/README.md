# Deployment

## Deployment targets

Run `pnpm flowdular deploy targets` to inspect the target contracts and
`pnpm flowdular deploy plan docker` before starting the local stack.
`pnpm flowdular deploy start docker --apply` starts Docker Compose and opens
first-run setup. It prints the setup token, so it requires a private
interactive terminal and refuses `--json` or redirected output.

The repository-root `render.yaml` is a Render Blueprint for an always-on
container. It needs external PostgreSQL with separate runtime, background and
migrator roles, verified TLS, S3 object storage and a public HTTPS origin.
The Blueprint prompts for these values and generates encryption keys. Back up
those keys separately. It uses `/api/health` during initial setup; verify
`/api/ready` after setup. See the main Flowdular deployment guide for details.
Vercel Functions are unavailable as a full target because their HTTP instances
can stop while scheduled module work is due. Cloudflare's Durable Object
Container API can keep a process alive, but Flowdular has no verified adapter
for its restart, secret and rollout lifecycle yet. A pushed Git repository can
use the Deploy to Render URL returned by `deploy plan render --json` after the
external prerequisites are supplied.

The production artifact is the server built from `platform`. It runs as a
non-root user and serves two public probes from
`platform/src/server/health.ts`: `GET /api/health` answers as soon as the
process is up and touches nothing else, so it is the liveness probe, and
`GET /api/ready` calls the database provider, checks that the runtime and
background roles hold neither `SUPERUSER` nor `BYPASSRLS`, and answers 503 with
`retry-after: 1` while the database is unavailable.

## Local container

```bash
node infra/docker/start.mjs
```

The launcher creates `infra/docker/.env` with owner-only permissions, generates
PostgreSQL passwords and platform keys once, and keeps them on later runs. It
starts PostgreSQL, a private MinIO bucket and the app. When the database is
empty, it opens the first-run setup in the workstation browser and prints the
one-time setup token in the terminal. Use `--no-open` on a headless host. The
normal address is `http://localhost:3000`; change `FD_PORT` in the Docker env
file to use another port. The container binds to `127.0.0.1` by default. A
generated Compose project name keeps this app's volumes separate from other
Flowdular projects on the same machine.

The database and object store are connected before the setup page appears, so
the wizard starts with workspace and owner details. After confirmation, Compose
restarts the app into the sign-in screen. AI models are optional and can be
connected in Providers after signing in. Mail remains off until the operator
sets `FD_AUTH_MAIL_TRANSPORT=smtp`, `FD_AUTH_SMTP_URL` and `FD_AUTH_MAIL_FROM`.

To run Compose directly, copy `infra/docker/.env.example` to
`infra/docker/.env`, fill every required secret, set
`FD_AUTH_SECURE_COOKIE=false` for local HTTP, and run
`docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml up --build`.
The setup token is in the `app` container logs. Keep that token out of URLs and
shared logs. For remote access, configure a TLS proxy, `FD_AUTH_PUBLIC_ORIGIN`,
`FD_BIND_ADDRESS` and secure cookies.

Compose gives the PostgreSQL runtime and background roles neither `SUPERUSER`
nor `BYPASSRLS`, and the migrator owns the schema. Its TLS certificate is
created once and verified by the app. The image ships the bundled server and a
small entrypoint that URL-encodes database passwords before starting it.

Back up the PostgreSQL data and WAL volumes, the MinIO object volume, and
`infra/docker/.env` together. The env file holds the keys needed to decrypt
records and objects after restore. `infra/docker/pitr.sh` can create a base
backup and replay archived PostgreSQL WAL segments; run its `--help` before a
restore, which requires explicit confirmation and stops the app when requested.

## Migrations on rollout

Module migrations run through the migration role on first use. Applied
migrations are immutable: add a numbered migration rather than editing one
that is already in the ledger. Check migration status with the workspace CLI
before a production rollout, and verify it afterwards.

## Published image

Build and publish the image from `infra/docker/Dockerfile`, then set the name in
`infra/kubernetes/kustomization.yaml` and `deployment.yaml`, which ship with an
`ghcr.io/OWNER/REPOSITORY` placeholder.

```bash
kubectl create secret generic flowdular-secrets \
  --from-literal=agentCredentialKey="$(openssl rand -base64 32)" \
  --from-literal=agentRunGrantKey="$(openssl rand -base64 32)" \
  --from-literal=automationsCredentialKey="$(openssl rand -base64 32)" \
  --from-literal=workflowsPayloadKey="$(openssl rand -base64 32)" \
  --from-literal=workflowsCursorKey="$(openssl rand -base64 32)"
kubectl create secret generic flowdular-database \
  --from-literal=migratorUrl='postgresql://coreloom_migrator:...@postgres:5432/flowdular' \
  --from-literal=runtimeUrl='postgresql://coreloom_runtime:...@postgres:5432/flowdular' \
  --from-literal=backgroundUrl='postgresql://coreloom_background:...@postgres:5432/flowdular'
kubectl apply -k infra/kubernetes
```

`secrets.example.yaml` and `database-secret.example.yaml` show both Secret shapes
with placeholders and are deliberately not part of the kustomization. Rotate
`agentCredentialKey` and `workflowsPayloadKey` through the `*_KEY_PREVIOUS`
variables rather than by replacing the value: the retired key keeps opening the
stored rows until `flowdular agents secrets-rotate --apply` and
`flowdular workflows secrets-rotate --apply` have re-sealed them. Replacing a key
outright does lose what it sealed, so follow the key rotation section of
`docs/operations.md`.

The Kubernetes base carries no volume for application data: the deployment is
stateless and every module writes to PostgreSQL. Scaling writers across nodes
needs nothing beyond the database they already share.

`.env.example` at the repository root lists every key the server reads,
including the optional mail transport settings.
