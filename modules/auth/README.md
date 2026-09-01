# Authentication Core

`auth.core` is the tenant-aware authentication and authorization boundary used by the application shell. Its approved spec is `spec/module.yaml`.

## Included

- Sign-up and sign-in screens in TSRX.
- Account, tenant, membership, scope, and session persistence in SQLite.
- Password hashing with scrypt and per-password random salts.
- Random session tokens stored only as SHA-256 hashes in the database.
- HttpOnly, host-only, `SameSite=Strict` cookies, with `Secure` enabled by default in production.
- Same-origin checks, CSRF verification for sign-out, input limits, and authentication attempt limiting.
- Authentication middleware plus `requireAuthentication()` and `requireScopes()` guards.
- Segment-backed browser state that stores only the principal and CSRF token in memory.

## Routes

| Method | Route                         | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/auth/config`            | Public sign-in configuration             |
| GET    | `/api/auth/session`           | Resolve the current session              |
| POST   | `/api/auth/sign-up`           | Create a tenant owner account            |
| POST   | `/api/auth/sign-in`           | Create a new session                     |
| POST   | `/api/auth/switch-tenant`     | Rotate into another membership           |
| POST   | `/api/auth/sign-out`          | Revoke the current session               |
| POST   | `/api/auth/password`          | Change the own password                  |
| POST   | `/api/auth/workspace`         | Rename the active workspace              |
| GET    | `/api/auth/api-tokens`        | List tenant API tokens                   |
| POST   | `/api/auth/api-tokens`        | Issue an API token                       |
| POST   | `/api/auth/api-tokens/revoke` | Revoke an API token                      |
| GET    | `/api/auth/roles`             | Tenant roles and grantable scopes        |
| POST   | `/api/auth/roles`             | Create a custom role                     |
| POST   | `/api/auth/roles/update`      | Change a custom role                     |
| POST   | `/api/auth/roles/delete`      | Delete an unused custom role             |
| GET    | `/api/auth/audit`             | Page through the tenant audit trail      |
| GET    | `/api/auth/sessions`          | List the own sessions                    |
| POST   | `/api/auth/sessions/revoke`   | End an own session, or all of a member's |

`GET /api/settings` and `POST /api/settings/update` are served by system.core;
auth.core owns the store and appends the `settings.updated` audit row through
the settings runtime's change listener.

Mutation requests require a matching `Origin` or `Referer`. Sign-out also requires the session CSRF value in `x-csrf-token`.

## API tokens

API tokens are machine credentials for clients that cannot hold a browser session, such as a sandbox connected to a remote deployment. An owner with `auth.tokens.manage` issues one from Administration or through the API. The raw value (`clat_...`) is returned once and stored only as a SHA-256 hash.

A client presents it as `Authorization: Bearer clat_...`. The authentication middleware resolves it only when no session cookie is present, and the effective scopes are the intersection of the token's recorded scopes with the membership's current scopes. Session-guarded mutations reject tokens with `TOKEN_MUTATION_DENIED`, so a token can read platform data and prove sandbox authority but cannot drive CSRF-protected writes. Revocation, expiry, and scope removal take effect on the next request.

## Configuration

| Variable                         | Default                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| `OERP_AUTH_DATABASE`             | `.octane-erp/auth.db`, or `/data/auth.db` in production             |
| `OERP_AUTH_SECURE_COOKIE`        | `false` in development and `true` in production                     |
| `OERP_AUTH_ALLOW_SIGN_UP`        | `true` in development and `false` in production                     |
| `OERP_AUTH_SESSION_TTL_HOURS`    | `12`                                                                |
| `OERP_AUTH_SESSION_IDLE_MINUTES` | `120`                                                               |
| `OERP_AUTH_PASSWORD_MIN_LENGTH`  | `12`                                                                |
| `OERP_AUTH_SIGN_IN_PROVIDERS`    | empty                                                               |
| `OERP_AUTH_EMAIL_CONFIRMATION`   | `false`; `true` is refused until a mail transport exists            |
| `OERP_TRUST_PROXY`               | `false`; `true` reads the client address from `x-forwarded-for`     |
| `OERP_CSP`                       | built-in policy; report-only in development, enforced in production |
| `OERP_CSP_REPORT_ONLY`           | `true` in development and `false` in production                     |

The auth values are defaults for the declared `auth.core` settings. A value
stored through the module's drawer under Administration > Modules wins at
read time.

Disabling secure cookies is only valid for local plain-HTTP development. Production traffic must use TLS.

## Sign-in protection

Sign-in and sign-up are throttled per submitted address (5 per 5 minutes) and,
behind a trusted proxy, per client address (20 per 5 minutes). Five failed
attempts lock the address for 15 minutes with the stable `ACCOUNT_LOCKED`
error; the lock is keyed by the submitted address whether or not an account
exists, so it never confirms a registration. Sessions end after the configured
idle period or absolute lifetime, and expired rows are swept every 15 minutes.

Every response carries `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` when secure
cookies are on, and a `Content-Security-Policy`. The production policy still
allows inline scripts because `platform/index.html` ships an un-nonced boot
script; once that script carries the octane nonce the policy can drop
`'unsafe-inline'`.

## Roles, audit, and settings

Every tenant carries `owner` and `member` as read-only rows in `auth_roles`;
custom roles grant a subset of the workspace's grantable scopes and are
assigned from Administration > Users. Administrative actions, sign-ins, and
settings changes are appended to `auth_audit` and shown under Administration >
Audit. Declared module settings are stored per tenant in `module_settings` and
edited per module under Administration > Modules; Administration > Settings
keeps only the workspace name and defaults such as the tenant locale.

## Module scopes

A module declares its scopes in its specification. Enabling it does not grant
them, so the scopes are handed to the workspace owners explicitly:

```bash
pnpm oerp auth sync-scopes --module profile.core          # dry run
pnpm oerp auth sync-scopes --module profile.core --apply
```

The command reads `permissions` from the module's specification, never from
module code, and the grant is idempotent. Members receive module scopes through
role assignment, not through this command. The sandbox runs it as part of an
eject, which is why an ejected module is reachable straight away.

## Greenfield development seed

Preview the local reset, seed credentials, and tenant layout:

```bash
pnpm oerp setup quick
```

Stop the development server, then apply the reset with typed confirmation:

```bash
pnpm oerp setup quick --apply --confirm reset-local-auth
```

The command resets only `.octane-erp/auth.db` inside the workspace. It creates:

- `admin@example.com` / `Admin!23456789`, an owner of Operations Demo and Finance Demo.
- `user@example.com` / `User!234567890`, a reduced-scope member of Operations Demo.

The application shell exposes the active tenant selector. Switching it rotates the session cookie and reloads the target membership's role and scopes. All seed values are public development defaults. The command refuses custom database paths and non-development environments. `auth greenfield` remains the module-owned equivalent of `setup quick`.

The current adapter is intentionally single-writer SQLite. Password reset, email verification, MFA, external identity providers, shared-database deployment, and distributed rate limiting require separate approved specs before implementation.
