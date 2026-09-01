# Deployment

The production artifact is the Octane fullstack server built from `platform`. It runs as a non-root user and exposes `GET /api/health` for container and orchestrator probes.

## Local container

```bash
docker compose -f infra/docker/compose.yaml up --build
```

Before the first start, copy `infra/docker/.env.example` to `infra/docker/.env` and fill in `OERP_AGENT_CREDENTIAL_KEY` and `OERP_AGENT_RUN_GRANT_KEY` (`openssl rand -base64 32` each). Compose refuses to start without them, and `agents.core` refuses to boot in production without them, so a missing key fails at startup rather than on the first provider request.

The service is available on `http://localhost:3000`. Set `OERP_PORT` to change the host port.

Compose provisions a named `/data` volume for the `auth.core` and `agents.core` SQLite databases and disables public sign-up by default. The session cookie is Secure (`__Host-` prefix) by default because the container expects TLS in front of it. For a plain-HTTP run on a workstation set `OERP_AUTH_SECURE_COOKIE=false` in `infra/docker/.env`; do not do this for anything reachable from a network.

The runtime image contains only `platform/dist` and `platform/package.json`. The server bundle imports node built-ins exclusively, so no `node_modules` directory ships with it.

## Published image

Tagging a release such as `v0.1.0`, or manually running the `Publish container` workflow, builds and publishes `ghcr.io/<owner>/<repository>`. Update the image name in `infra/kubernetes/kustomization.yaml` before applying it.

```bash
kubectl create secret generic octane-erp-agents \
  --from-literal=credentialKey="$(openssl rand -base64 32)" \
  --from-literal=runGrantKey="$(openssl rand -base64 32)"
kubectl apply -k infra/kubernetes
```

The Deployment reads `OERP_AGENT_CREDENTIAL_KEY` and `OERP_AGENT_RUN_GRANT_KEY` from the `octane-erp-agents` Secret. `agents-secret.example.yaml` shows its shape with placeholders and is deliberately not part of the kustomization. Rotating `credentialKey` invalidates every stored provider credential; re-enter them under Providers afterwards.

The Kubernetes base includes a 1 GiB PVC for authentication and agent control-plane data. Replace the storage class, access mode, and replica strategy for the target environment. SQLite is suitable for the initial single-writer control plane. A multi-region deployment requires an approved migration to a shared database adapter and durable queue before scaling writers across nodes.
