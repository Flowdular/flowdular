# Configuration

Runtime options are environment variables prefixed `FD_`. Every value has a
development default, so a local checkout needs none of them. Production
deployments must set the secret keys.

## Platform

| Variable             | Default                        | Purpose                                          |
| -------------------- | ------------------------------ | ------------------------------------------------ |
| `FD_ENV`             | `NODE_ENV`, else `development` | Environment the CLI and destructive guards check |
| `FD_PORT`            | `3000`                         | Host port published by the container             |
| `FD_TRUST_PROXY`     | `false`                        | Trust `X-Forwarded-*` behind a reverse proxy     |
| `FD_CSP`             | built-in policy                | Override the Content Security Policy             |
| `FD_CSP_REPORT_ONLY` | `true` outside production      | Report CSP violations instead of enforcing them  |

## Database

Flowdular runs on PostgreSQL. One platform-owned provider serves every module, so
there is one database and no per-module option. Outside production the adapter
is PGlite, the same engine embedded in the process, which is why a local
checkout needs no server.

| Variable                           | Default                                   | Purpose                                                                      |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `FD_DATABASE_ADAPTER`              | `postgresql` in production, else `pglite` | `pglite` or `postgresql`; `pglite` is refused in production                  |
| `FD_DATABASE_PGLITE_DIRECTORY`     | `.flowdular/data/pglite`                  | Data directory of the embedded database; ignored under `NODE_ENV=test`       |
| `FD_DATABASE_URL`                  | none                                      | Runtime PostgreSQL DSN; the role must not hold `BYPASSRLS`                   |
| `FD_DATABASE_MIGRATOR_URL`         | `FD_DATABASE_URL` outside production      | Schema-owning PostgreSQL DSN; required in production                         |
| `FD_DATABASE_BACKGROUND_URL`       | none                                      | Cross-tenant read-only DSN; without it a `background` lease is refused       |
| `FD_DATABASE_TLS`                  | `verify-full`                             | `verify-full`, `require`, or `disable`; production allows only `verify-full` |
| `FD_DATABASE_TLS_CA`               | none                                      | Certificate authority as an inline PEM value                                 |
| `FD_DATABASE_TLS_CA_FILE`          | none                                      | Certificate authority read from a mounted file                               |
| `FD_DATABASE_POOL_MIN`             | `0`                                       | Minimum pooled connections per role                                          |
| `FD_DATABASE_POOL_MAX`             | `10`                                      | Maximum pooled connections per role                                          |
| `FD_DATABASE_CONNECT_TIMEOUT_MS`   | `5000`                                    | Connection acquisition timeout                                               |
| `FD_DATABASE_IDLE_TIMEOUT_MS`      | `30000`                                   | Idle connection timeout                                                      |
| `FD_DATABASE_STATEMENT_TIMEOUT_MS` | `15000`                                   | Server-side statement timeout                                                |
| `FD_DATABASE_QUERY_TIMEOUT_MS`     | `20000`                                   | Driver query timeout; never shorter than the statement timeout               |
| `FD_DATABASE_LOCK_TIMEOUT_MS`      | `5000`                                    | Server-side lock timeout; never longer than the statement timeout            |

Production refuses a shared runtime and migrator DSN, refuses TLS weaker than
`verify-full`, and refuses a runtime role with `SUPERUSER` or `BYPASSRLS`.
`GET /api/ready` reports the adapter and answers 503 while the database is
unreachable. Set the authority either inline or as a file, never both.

## Authentication (`auth.core`)

| Variable                       | Default                   | Purpose                                                                                           |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `FD_AUTH_ALLOW_SIGN_UP`        | `true` outside production | Expose account creation                                                                           |
| `FD_AUTH_SECURE_COOKIE`        | `true` in production      | Secure flag and `__Host-` prefix on the session cookie                                            |
| `FD_AUTH_PUBLIC_ORIGIN`        | request origin            | Absolute public origin, HTTPS unless loopback                                                     |
| `FD_AUTH_SESSION_TTL_HOURS`    | `12` (1 to 168)           | Absolute session lifetime                                                                         |
| `FD_AUTH_SESSION_IDLE_MINUTES` | `120` (5 to 1440)         | Idle timeout                                                                                      |
| `FD_AUTH_PASSWORD_MIN_LENGTH`  | `12` (8 to 128)           | Minimum password length                                                                           |
| `FD_AUTH_EMAIL_CONFIRMATION`   | `false`                   | Hold the session after sign-up until the address is confirmed; requires a composed mail transport |
| `FD_AUTH_DEVELOPMENT_MAIL`     | `false`                   | In-memory mail delivery, refused in production                                                    |
| `FD_AUTH_SIGN_IN_PROVIDERS`    | empty                     | Comma list of external providers rendered on sign-in                                              |
| `FD_AUTH_OIDC_PROVIDERS`       | empty                     | JSON array of at most eight OIDC provider configurations                                          |
| `FD_AUTH_MFA_KEY`              | unset                     | Base64 32-byte key encrypting MFA secrets; MFA enrollment is unavailable without it               |

Listing a provider in `FD_AUTH_SIGN_IN_PROVIDERS` only surfaces the button; the
matching `/api/auth/sso/{provider}/start` handler must be composed at the
platform level.

## Agents (`agents.core`)

| Variable                           | Default           | Purpose                                              |
| ---------------------------------- | ----------------- | ---------------------------------------------------- |
| `FD_AGENT_CREDENTIAL_KEY`          | generated dev key | Base64 32-byte key for the provider credential vault |
| `FD_AGENT_RUN_GRANT_KEY`           | generated dev key | Base64 32-byte key signing run grants                |
| `FD_AGENT_WORKER_CONCURRENCY`      | `2` (1 to 16)     | Parallel run workers                                 |
| `FD_AGENT_WORKER_LEASE_MS`         | `30000`           | Run lease before recovery reclaims it                |
| `FD_AGENT_PROVIDER_HOST_ALLOWLIST` | empty             | Hostnames an external provider may be called on      |

Outside production the keys are generated once under `.flowdular/data`. Both are
required in production: the module refuses to boot without them.
Rotating `FD_AGENT_CREDENTIAL_KEY` invalidates every stored provider credential.

## Workflows (`workflows.core`)

| Variable                   | Default         | Purpose                                      |
| -------------------------- | --------------- | -------------------------------------------- |
| `FD_WORKFLOWS_PAYLOAD_KEY` | derived dev key | Base64 32-byte key encrypting run payloads   |
| `FD_WORKFLOWS_CURSOR_KEY`  | derived dev key | Base64 32-byte key signing execution cursors |

Both keys are required in production. Rotating the payload key makes retained
execution payloads unreadable, so drain runs and let retention remove payloads
first.

## Sandbox

| Variable               | Default           | Purpose                                      |
| ---------------------- | ----------------- | -------------------------------------------- |
| `FD_SANDBOX_URL`       | unset             | Absolute URL of the sandbox the app links to |
| `FD_SANDBOX_WORKSPACE` | current directory | Workspace the launcher serves                |
| `FD_SANDBOX_PORT`      | `4320`            | Launcher port                                |
| `FD_SANDBOX_MODE`      | launcher `--mode` | Local or self-hosted provider mode           |

## Business modules

A module with the `database` capability has no database option of its own. It
acquires a lease from the platform provider configured above, so the
`FD_DATABASE_*` values are the only place storage is configured. See
[database-adapters.md](database-adapters.md).

## Landing site

| Variable          | Default | Purpose          |
| ----------------- | ------- | ---------------- |
| `FD_LANDING_PORT` | `4330`  | Development port |

## Generating keys

```bash
openssl rand -base64 32
```

For containers, copy `infra/docker/.env.example` to `infra/docker/.env` and fill
in every empty value: the four encryption keys above and the four PostgreSQL
role passwords. See [../infra/README.md](../infra/README.md).
