# Deployment

The production artifact is the server built from `platform`. It runs as a
non-root user and serves two public probes from
`platform/src/server/health.ts`: `GET /api/health` answers as soon as the
process is up and touches nothing else, so it is the liveness probe, and
`GET /api/ready` calls the database provider, checks that the runtime and
background roles hold neither `SUPERUSER` nor `BYPASSRLS`, and answers 503 with
`retry-after: 1` while the database is unavailable.

## Local container

```bash
cp .env.example infra/docker/.env   # then fill in every value
docker compose -f infra/docker/compose.yaml up --build
```

Compose refuses to start while a key or a database password is empty, and the
owning module would refuse at boot anyway. The app is published on
`http://localhost:3000`; set `FD_PORT` to change the host port.

The build stage runs `pnpm install --frozen-lockfile`, so commit
`pnpm-lock.yaml` before building.

Compose also starts PostgreSQL. A one-shot `postgres-tls` service generates a
self-signed server certificate for `CN=postgres` on first run, Postgres serves
TLS with it, and the app verifies it through `FD_DATABASE_TLS_CA_FILE` under
`verify-full`. First cluster initialization creates three roles:
`coreloom_migrator` owns the schema, `coreloom_runtime` holds neither
`SUPERUSER` nor `BYPASSRLS`, so the row-level security tenant tables force
actually binds the application, and `coreloom_background` serves the
cross-tenant scheduler poll with no default table grant at all.

Public sign-up is disabled. The session cookie is Secure (`__Host-` prefix)
because the container expects TLS in front of it. For a plain-HTTP run on a
workstation set `FD_AUTH_SECURE_COOKIE=false` in `infra/docker/.env`; do not do
this for anything reachable from a network.

The runtime image contains only `platform/dist` and `platform/package.json`. The
server bundle imports node built-ins exclusively, so no `node_modules` directory
ships with it.

## Migrations on rollout

Every module owns its migrations and applies them itself, inside a migration
lease that connects as `FD_DATABASE_MIGRATOR_URL`, the first time its runtime is
used. A rollout therefore needs no apply step: start the new image and the
schema catches up under the schema-owning role, while requests keep running as
the runtime role.

What a rollout should do is fail before the new image serves traffic when an
already applied migration no longer matches the code being deployed. That is the
one-shot `migration-check` service in `infra/docker/compose.yaml`: it runs
`flowdular migration status --json`, reports what is pending, and exits non-zero
on a checksum mismatch. `app` starts only after it completes successfully.

```bash
docker compose -f infra/docker/compose.yaml run --rm migration-check
```

Outside compose, run the same check from a checkout with the deployment's
`FD_DATABASE_*` values in the environment. On Kubernetes it belongs in a
pre-upgrade Job or in the pipeline step ahead of `kubectl apply`. After the
rollout, `flowdular migration verify` should come back clean.

`flowdular migration apply` exists, but it is not part of a rollout. It takes one
module at a time (`--module <id> --apply`; there is no `--all` flag) and the
capability is local-only: the runner refuses it unless `FD_ENV` or `NODE_ENV` is
`development` or `test`. Use it on a workstation against a local database:

```bash
pnpm flowdular migration status                       # pending work, per module
pnpm flowdular migration apply --module example.core  # dry run
pnpm flowdular migration apply --module example.core --apply
```

Repeat the last two lines for each module `migration status` reports.

Applied migrations are immutable. To change schema, add a numbered migration;
never edit one the ledger already recorded.

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
