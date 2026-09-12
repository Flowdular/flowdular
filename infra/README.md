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
