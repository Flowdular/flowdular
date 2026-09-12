# Authentication Core

`auth.core` is the tenant-aware authentication and authorization boundary used by the application shell. Its approved spec is `spec/module.yaml`.

## Included

- Sign-up and sign-in screens in TSRX.
- Account, tenant, membership, scope, and session persistence in PostgreSQL, through the platform-owned `@flowdular/database` provider.
- Password hashing with scrypt and per-password random salts.
- Random session tokens stored only as SHA-256 hashes in the database.
- HttpOnly, host-only, `SameSite=Strict` cookies, with `Secure` enabled by default in production.
- Same-origin checks, CSRF verification for sign-out, input limits, and authentication attempt limiting.
- Authentication middleware plus `requireAuthentication()` and `requireScopes()` guards.
- Segment-backed browser state that stores only the principal and CSRF token in memory.

## Routes

| Method | Route                               | Purpose                                   |
| ------ | ----------------------------------- | ----------------------------------------- |
| GET    | `/api/auth/config`                  | Public sign-in configuration              |
| GET    | `/api/auth/session`                 | Resolve the current session               |
| POST   | `/api/auth/sign-up`                 | Create a tenant owner account             |
| POST   | `/api/auth/sign-in`                 | Create a new session                      |
| POST   | `/api/auth/switch-tenant`           | Rotate into another membership            |
| POST   | `/api/auth/sign-out`                | Revoke the current session                |
| POST   | `/api/auth/password`                | Change the own password                   |
| POST   | `/api/auth/workspace`               | Rename the active workspace               |
| GET    | `/api/auth/api-tokens`              | List tenant API tokens                    |
| POST   | `/api/auth/api-tokens`              | Issue an API token                        |
| POST   | `/api/auth/api-tokens/revoke`       | Revoke an API token                       |
| GET    | `/api/auth/roles`                   | Tenant roles and grantable scopes         |
| POST   | `/api/auth/roles`                   | Create a custom role                      |
| POST   | `/api/auth/roles/update`            | Change a custom role                      |
| POST   | `/api/auth/roles/delete`            | Delete an unused custom role              |
| GET    | `/api/auth/audit`                   | Page through the tenant audit trail       |
| GET    | `/api/auth/sessions`                | List the own sessions                     |
| POST   | `/api/auth/sessions/revoke`         | End an own session, or all of a member's  |
| GET    | `/api/auth/providers`               | Workspace and platform identity providers |
| POST   | `/api/auth/providers`               | Create a workspace identity provider      |
| POST   | `/api/auth/providers/update`        | Change a workspace identity provider      |
| POST   | `/api/auth/providers/enable`        | Offer it on the sign-in screen            |
| POST   | `/api/auth/providers/disable`       | Stop offering it                          |
| POST   | `/api/auth/providers/rotate-secret` | Replace its client secret                 |
| POST   | `/api/auth/providers/delete`        | Delete a disabled provider                |
| POST   | `/api/auth/memberships/status`      | Disable or re-enable one membership       |

`GET /api/settings` and `POST /api/settings/update` are served by system.core;
auth.core owns the store and appends the `settings.updated` audit row through
the settings runtime's change listener.

Mutation requests require a matching `Origin` or `Referer`. Sign-out also requires the session CSRF value in `x-csrf-token`.

## API tokens

API tokens are machine credentials for clients that cannot hold a browser session, such as a sandbox connected to a remote deployment. An owner with `auth.tokens.manage` issues one from Administration or through the API. The raw value (`clat_...`) is returned once and stored only as a SHA-256 hash.

A client presents it as `Authorization: Bearer clat_...`. The authentication middleware resolves it only when no session cookie is present, and the effective scopes are the intersection of the token's recorded scopes with the membership's current scopes. Session-guarded mutations reject tokens with `TOKEN_MUTATION_DENIED`, so a token can read platform data and prove sandbox authority but cannot drive CSRF-protected writes. Revocation, expiry, and scope removal take effect on the next request.

## Identity providers

A workspace adds OIDC providers of its own in Administration, Identity
providers, behind `auth.providers.read` and `auth.providers.manage`. The issuer
is verified through its discovery document when it is saved, the endpoints that
document publishes are stored with it, and the client secret is sealed with the
deployment authentication key (`FD_AUTH_MFA_KEY`) under a provider-specific
context. Nothing returns the secret afterwards: administrators see its
fingerprint, and `pnpm flowdular auth secrets-rotate` re-seals provider secrets
beside the enrolled TOTP factors.

Sign-in is routed by workspace. `GET /api/auth/config?workspace=<slug>` answers
with the password form, that workspace's enabled providers and the platform
providers from `FD_AUTH_OIDC_PROVIDERS`. A workspace provider starts at
`/api/auth/oidc/<workspace>/<key>/start`; the signed state cookie binds both,
and a callback whose state names another workspace is refused. A platform
provider keeps its own `/api/auth/oidc/<id>/start` route and keeps binding
identities without a workspace.

Just-in-time provisioning is off per provider. Turned on, it takes a non-empty
list of allowed e-mail domains and the role a new member receives (`member` by
default). A verified address inside those domains creates or reuses the account,
creates an active membership with the role's scopes and an `auth.member.provisioned`
audit row. Without it, an external sign-in needs an existing membership; an
address outside the domains is refused before anything is written.

## Membership status

Every membership carries its own status. `POST /api/auth/memberships/status`
(`users.members.manage`, session and CSRF required) disables or re-enables the
membership of the acting workspace: disabling revokes that workspace's sessions
and API tokens for the account, refuses its sign-in and tenant switch, and
leaves the person's other workspaces untouched. Re-enabling restores sign-in;
the revoked tokens stay revoked. The account status column stays what it was,
the deployment operator's platform-level block.

## Configuration

| Variable                       | Default                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `FD_AUTH_SECURE_COOKIE`        | `false` in development and `true` in production                     |
| `FD_AUTH_ALLOW_SIGN_UP`        | `true` in development and `false` in production                     |
| `FD_AUTH_SESSION_TTL_HOURS`    | `12`                                                                |
| `FD_AUTH_SESSION_IDLE_MINUTES` | `120`                                                               |
| `FD_AUTH_PASSWORD_MIN_LENGTH`  | `12`                                                                |
| `FD_AUTH_SIGN_IN_PROVIDERS`    | empty                                                               |
| `FD_AUTH_EMAIL_CONFIRMATION`   | `false`; `true` is refused until a mail transport exists            |
| `FD_TRUST_PROXY`               | `false`; `true` reads the client address from `x-forwarded-for`     |
| `FD_CSP`                       | built-in policy; report-only in development, enforced in production |
| `FD_CSP_REPORT_ONLY`           | `true` in development and `false` in production                     |

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
cookies are on, and a `Content-Security-Policy`. The production shell replaces
its bootstrap nonce per response, so `script-src` does not allow
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
pnpm flowdular auth sync-scopes --module profile.core          # dry run
pnpm flowdular auth sync-scopes --module profile.core --apply
```

The command reads `permissions` from the module's specification, never from
module code, and the grant is idempotent. Members receive module scopes through
role assignment, not through this command. The sandbox runs it as part of an
eject, which is why an ejected module is reachable straight away.

## Operator provisioning

A deployment turns public sign-up off, so its first workspace and every later
colleague arrive through the CLI. The commands use the deployment database
through the platform provider, work against a PostgreSQL server, read nothing
from `FD_AUTH_ALLOW_SIGN_UP`, and reset nothing.

```bash
pnpm flowdular auth workspaces                                     # what exists, with owners
pnpm flowdular auth workspace-create --name "Northwind" \
  --owner-email ada@northwind.example --owner-name "Ada Lovelace" # dry run
pnpm flowdular auth workspace-create --name "Northwind" \
  --owner-email ada@northwind.example --owner-name "Ada Lovelace" --apply
pnpm flowdular auth member-add --workspace northwind \
  --email grace@northwind.example --role member --apply
```

`workspace-create` writes the tenant, the owner account, the owner membership
and `OWNER_SCOPES`, exactly as sign-up does, so the workspace is
indistinguishable from one created in the browser. The workspace id comes from
`--slug` or is derived from the name, and both it and the email pass the
validators the sign-up path uses. A taken workspace id or a registered address
is refused with a stable `WORKSPACE_SLUG_TAKEN` or `ACCOUNT_EXISTS` error.

| Flag              | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `--name`          | Workspace name, 2 to 120 characters                        |
| `--slug`          | Workspace id; derived from the name when absent            |
| `--owner-email`   | Owner address, normalized the way sign-up normalizes it    |
| `--owner-name`    | Owner display name                                         |
| `--password-env`  | Name of an environment variable holding the owner password |
| `--actor <label>` | Audit actor suffix; defaults to the OS user                |
| `--workspace`     | `member-add` target, by workspace id or tenant identifier  |
| `--role <key>`    | `member-add` role, `member` by default                     |
| `--limit <n>`     | `workspaces` page size, 1 to 200, 25 by default            |

### How the first credential reaches the operator

By default the command emits a single-use password setup link over the existing
`auth_password_reset_tokens` table: only the token hash is stored, it is valid
for 24 hours, it can be used once, and it is printed exactly once. Nothing can
recover it afterwards, and it never reaches the audit trail. Set
`FD_AUTH_PUBLIC_ORIGIN` so the link points at the deployment; without it the
command warns and falls back to `http://localhost`.

The command mints that token itself rather than going through
`requestPasswordReset` or `createTenantInvitation`. Both of those hand their
token to the injected `AuthMailDelivery` adapter and to nobody else:
`createTenantInvitation` refuses with `MAIL_NOT_CONFIGURED` when none is
composed, and `requestPasswordReset` answers generically while the server logs
that the message was not delivered. A deployment that configures no transport
still has an operator standing at a shell on the server as its delivery channel,
and the terminal is the one channel that always exists.

`--password-env` takes the **name** of an environment variable, never the
password. A password passed as a flag value lands in shell history and in the
process list of every other user on the host, so a value that is not a variable
name is refused without being echoed back. With `--password-env` the command
emits no link and no password.

`member-add` needs no credential for an address that already has an account: it
adds the membership with the role's scopes. An unknown address gets a
single-use invitation link over `auth_tenant_invitations`, shown once, which
the invited person opens to choose their own display name and password.

Both commands are `risk: process` capabilities: they are a dry run without
`--apply` and print the workspace, the account and the scopes they would
create. Each append an audit row to the workspace trail with the operator as
the actor (`cli:<user>`, or `cli:<label>` with `--actor`), so an owner never
appears without a record of who made it.

## Greenfield development seed

Preview the local reset, seed credentials, and tenant layout:

```bash
pnpm flowdular setup quick
```

Stop the development server, then apply the reset with typed confirmation:

```bash
pnpm flowdular setup quick --apply --confirm reset-local-auth
```

The command resets only the workspace's local embedded database, and refuses to run when a PostgreSQL server is configured. It creates:

- `admin@example.com` / `Owner!23456789`, an owner of Operations Demo and Finance Demo.
- `user@example.com` / `Member!2345678`, a reduced-scope member of Operations Demo.

The application shell exposes the active tenant selector. Switching it rotates the session cookie and reloads the target membership's role and scopes. All seed values are public development defaults. The command refuses a configured PostgreSQL server and non-development environments. `auth greenfield` remains the module-owned equivalent of `setup quick`.

auth.core stores everything in PostgreSQL through the platform provider, which
means a deployment must configure `FD_DATABASE_BACKGROUND_URL`: a session
cookie, a bearer token, an invitation link and an email address all arrive
without a workspace, and that read-only cross-tenant role is what resolves the
one they belong to. Password reset,
tenant invitations, TOTP MFA, and OIDC use injected deployment configuration:
`FD_AUTH_MFA_KEY` is a 32-byte AES key encoded as 64 hexadecimal characters
or base64url, `FD_AUTH_PUBLIC_ORIGIN` is the public HTTPS origin, and
`FD_AUTH_OIDC_PROVIDERS` is a JSON list of configured OIDC endpoints and
credentials, which every workspace is offered read-only. Email delivery is
injected through `AuthMailDelivery` and selected
by `FD_AUTH_MAIL_TRANSPORT`: `smtp` relays through `FD_AUTH_SMTP_URL` and
`FD_AUTH_MAIL_FROM`, while `development` (also reached by the older
`FD_AUTH_DEVELOPMENT_MAIL=true`) keeps messages in memory and is refused in
production. No transport logs or exposes a raw token, an address, or the relay
credentials.
