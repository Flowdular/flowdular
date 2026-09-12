# Configuration

Runtime options are environment variables prefixed `FD_`. Every value has a
development default, so a local checkout needs none of them. Production
deployments must set the secret keys.

## Platform

| Variable             | Default                           | Purpose                                                                    |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `FD_ENV`             | `NODE_ENV`, else `development`    | Environment the CLI and destructive guards check                           |
| `FD_PORT`            | `3000`                            | Host port published by the container                                       |
| `FD_TRUST_PROXY`     | `false`                           | Trust `X-Forwarded-*` behind a reverse proxy                               |
| `FD_CSP`             | built-in policy                   | Override the Content Security Policy                                       |
| `FD_CSP_REPORT_ONLY` | `true` outside production         | Report CSP violations instead of enforcing them                            |
| `FD_LOG_FORMAT`      | `json` in production, else `text` | `json` (one object per line) or `text`; see [operations.md](operations.md) |
| `FD_LOG_LEVEL`       | `info`                            | `debug`, `info`, `warn` or `error`                                         |
| `FD_METRICS`         | `false`                           | Expose `GET /api/metrics`; see [operations.md](operations.md)              |
| `FD_METRICS_TOKEN`   | none                              | Bearer token a metrics scrape must present                                 |

## Observability

Spans are always recorded into a bounded in-process buffer and the logger always
writes the trace id; only the two egresses below are optional, and a
misconfigured one fails the boot rather than silently sending nothing.

| Variable                | Default | Purpose                                                                   |
| ----------------------- | ------- | ------------------------------------------------------------------------- |
| `FD_TRACE_SAMPLE`       | `1`     | Ratio of new root traces recorded, 0 to 1                                 |
| `FD_TRACE_EXPORTER`     | `none`  | `none` or `otlp`; see [operations.md](operations.md)                      |
| `FD_TRACE_OTLP_URL`     | none    | OTLP/HTTP JSON traces endpoint; required with `otlp`, https in production |
| `FD_TRACE_OTLP_HEADERS` | none    | `name=value,name2=value2` sent with every batch, at most 16               |
| `FD_ERROR_SINK`         | `none`  | `none` or `webhook`; where a logged error is reported                     |
| `FD_ERROR_SINK_URL`     | none    | Webhook endpoint; required with `webhook`, https in production            |
| `FD_ERROR_SINK_TOKEN`   | none    | Bearer credential the webhook request presents                            |

A sample ratio outside 0 to 1, an unknown exporter or sink, a missing URL, a
plain `http` endpoint in production and a malformed header list are all refused
while the platform composes. An unsampled trace still propagates its
`traceparent`, so a downstream service keeps the correlation.

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

| Variable                               | Default                   | Purpose                                                                                                                 |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FD_AUTH_ALLOW_SIGN_UP`                | `true` outside production | Expose account creation                                                                                                 |
| `FD_AUTH_SECURE_COOKIE`                | `true` in production      | Secure flag and `__Host-` prefix on the session cookie                                                                  |
| `FD_AUTH_PUBLIC_ORIGIN`                | request origin            | Absolute public origin, HTTPS unless loopback                                                                           |
| `FD_AUTH_SESSION_TTL_HOURS`            | `12` (1 to 168)           | Absolute session lifetime                                                                                               |
| `FD_AUTH_SESSION_IDLE_MINUTES`         | `120` (5 to 1440)         | Idle timeout                                                                                                            |
| `FD_AUTH_PASSWORD_MIN_LENGTH`          | `12` (8 to 128)           | Minimum password length                                                                                                 |
| `FD_AUTH_EMAIL_CONFIRMATION`           | `false`                   | Hold the session after sign-up; needs a mail transport. auth.core composes no confirmation message yet, so none is sent |
| `FD_AUTH_MAIL_TRANSPORT`               | `none`                    | Deprecated spelling of `FD_MAIL_TRANSPORT`; see Mail                                                                    |
| `FD_AUTH_SMTP_URL`                     | none                      | Deprecated spelling of `FD_MAIL_SMTP_URL`; see Mail                                                                     |
| `FD_AUTH_MAIL_FROM`                    | none                      | Deprecated spelling of `FD_MAIL_FROM`; see Mail                                                                         |
| `FD_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED` | `true`                    | Deprecated spelling of `FD_MAIL_SMTP_TLS_REJECT_UNAUTHORIZED`; see Mail                                                 |
| `FD_AUTH_SMTP_REQUIRE_TLS`             | `true`                    | Deprecated spelling of `FD_MAIL_SMTP_REQUIRE_TLS`; see Mail                                                             |
| `FD_AUTH_DEVELOPMENT_MAIL`             | `false`                   | Deprecated switch for `FD_MAIL_TRANSPORT=development`; in-memory, refused in production                                 |
| `FD_AUTH_SIGN_IN_PROVIDERS`            | empty                     | Comma list of external providers rendered on sign-in                                                                    |
| `FD_AUTH_OIDC_PROVIDERS`               | empty                     | JSON array of at most eight OIDC provider configurations                                                                |
| `FD_AUTH_PROVIDER_HOST_ALLOWLIST`      | empty                     | Comma list of hosts a provider URL may name; empty allows any public host                                               |
| `FD_AUTH_MFA_KEY`                      | unset                     | Base64 32-byte key encrypting MFA secrets; MFA enrollment is unavailable without it                                     |
| `FD_AUTH_MFA_KEY_PREVIOUS`             | empty                     | Comma list of retired MFA keys, kept readable until `auth secrets-rotate --apply` re-seals them                         |

Listing a provider in `FD_AUTH_SIGN_IN_PROVIDERS` only surfaces the button. The
matching entry in `FD_AUTH_OIDC_PROVIDERS` is what makes
`/api/auth/oidc/{provider}/start` serve it; a listed id without one is dropped
from the sign-in screen. SAML is not implemented, so no provider id is served
over SAML.

Each entry of `FD_AUTH_OIDC_PROVIDERS` requires `id`, `issuer`,
`authorizationEndpoint`, `tokenEndpoint`, `userInfoEndpoint`, `clientId` and
`clientSecret`, all HTTPS URLs except the ids and the credentials:

```json
[
	{
		"id": "example",
		"issuer": "https://identity.example",
		"authorizationEndpoint": "https://identity.example/authorize",
		"tokenEndpoint": "https://identity.example/token",
		"userInfoEndpoint": "https://identity.example/userinfo",
		"clientId": "client-id",
		"clientSecret": "client-secret"
	}
]
```

`issuer` is required and is the exact `iss` value the provider puts in its ID
tokens. The callback reads `{issuer}/.well-known/openid-configuration` and the
`jwks_uri` it names, caches both for ten minutes, and verifies every ID token
against that key set: RS256 or ES256 signature, `iss`, `aud`, `exp` and `iat`
within five minutes, and the `nonce` bound to the signed state cookie. A
provider entry without `issuer` refuses the boot, and a token that fails any
check ends the flow with `OIDC_AUTHENTICATION_FAILED`. The verified `sub` is
stored on the account and identifies it on later sign-ins, so an address change
at the provider does not move the session to another account.

### Platform and workspace identity providers

Every `FD_AUTH_OIDC_PROVIDERS` entry is a platform provider: it is read at boot,
offered to every workspace read-only, served from `/api/auth/oidc/{id}/start`,
and binds identities without a workspace exactly as before. A workspace adds
providers of its own in Administration, Identity providers, behind
`auth.providers.read` and `auth.providers.manage`, and they are stored in
`auth_identity_providers` under the workspace's forced row-level security. No
API changes a platform provider.

A workspace provider is saved with an HTTPS issuer that is verified through the
same discovery path (`{issuer}/.well-known/openid-configuration` naming the same
issuer back); the authorization, token and userinfo endpoints that document
publishes are stored with it. Its client secret is entered once, sealed with the
deployment key in `FD_AUTH_MFA_KEY` under a provider-specific context, and never
returned: administrators see a fingerprint. `pnpm flowdular auth secrets-rotate`
re-seals workspace provider secrets in bounded batches beside the enrolled TOTP
factors, and reports counts per table; the fingerprint does not change, because
the secret behind it did not. A platform provider shows no fingerprint at all:
its secret is the deployment's, shared by every workspace, so no workspace is
handed a value derived from it.

`POST /api/auth/providers/update` is a partial update. It needs the `id`, and
every field it leaves out keeps what the stored row has, so sending only
`{ id, label }` renames a provider and changes nothing about its issuer, client
id, scopes, provisioning, domains or role. The merged record is validated as a
whole, so turning `jitEnabled` on without sending `allowedDomains` is refused
when the stored list is empty. Sending `clientSecret` here replaces the secret,
exactly as `POST /api/auth/providers/rotate-secret` does; leaving it out keeps
the sealed one. A role a provider names in `jitRole` cannot be deleted while it
does: `POST /api/auth/roles/delete` answers `ROLE_NAMED_BY_PROVIDER` (409) until
the provider is pointed at another role.

Every URL auth.core fetches for a provider is host-guarded before the request
leaves: the issuer a save supplies, the endpoints its discovery document
publishes, and the stored token and userinfo endpoints a sign-in uses. The URL
must be HTTPS without credentials and must name a host, never `localhost`, a
`.local`, `.localhost` or `.internal` name, or a literal address, which is what
keeps a deployment from being pointed at 127.0.0.1, 10/8, 172.16/12,
192.168/16, 169.254/16 or their IPv6 equivalents. `FD_AUTH_PROVIDER_HOST_ALLOWLIST`
narrows it further to an exact comma-separated list of hostnames, the way
`FD_AGENT_PROVIDER_HOST_ALLOWLIST` does for agent providers; empty allows any
public host. A refused save answers `PROVIDER_HOST_BLOCKED` or
`PROVIDER_HOST_NOT_ALLOWLISTED` (400) before anything is fetched, and a sign-in
against a refused stored endpoint ends with the generic
`OIDC_AUTHENTICATION_FAILED`. Set the allowlist on any deployment where
workspaces configure their own providers: without it a hostname that resolves
into a private range is still reachable, since the guard does not resolve names.

Sign-in is routed by workspace. `GET /api/auth/config?workspace={slug}` answers
with the password form, that workspace's enabled providers and the platform
providers; an unknown workspace answers exactly as none at all. A workspace
provider starts at `/api/auth/oidc/{workspace}/{key}/start` and returns to
`/api/auth/oidc/{workspace}/{key}/callback`, which is the redirect URI to
register with the provider. The signed state cookie binds the workspace and the
provider key, and a callback whose state names another workspace is refused
before the code is exchanged. A workspace provider opens a session in its own
workspace only.

The password form is routed the same way. `POST /api/auth/sign-in` takes an
optional `workspace` (the id or slug the screen resolved, at most 128
characters): the account has to hold an active membership there, and the session
opens in that workspace whether or not it is the account's oldest one. A
workspace that does not exist and a workspace the account is not a member of
both answer the same `INVALID_CREDENTIALS` (401) a wrong password does, so the
form reports nothing about which workspaces hold an address. Without the field
the oldest membership answers, exactly as before.

The workspace lookup behind `GET /api/auth/config?workspace={slug}` is bounded
per workspace reference, 120 per minute, and per client address plus workspace
when `FD_TRUST_PROXY` is on and a proxy reports one. Enumerating workspace ids
is what the bound is for; a visitor asking for another workspace never spends
the first one's allowance.

### Just-in-time provisioning

Provisioning is off per provider. Turned on, it requires a non-empty list of
allowed e-mail domains and the role a new member receives (a role key of that
workspace; `member` by default). A verified address inside those domains creates
or reuses the account, creates an active membership with the role's scopes,
appends an `auth.member.provisioned` audit row and opens the session. With
provisioning off, an external sign-in needs an existing membership; an address
outside the allowed domains is refused before any account or membership is
written. Both refusals answer with the same stable external sign-in error.

### Membership status

Membership status is per workspace. `POST /api/auth/memberships/status` with
`{ accountId, status }` (scope `users.members.manage`, browser session and
`x-csrf-token` required) disables or re-enables the membership of the acting
workspace: disabling revokes that workspace's sessions and API tokens for the
account and refuses its sign-in and tenant switch, while the person's other
workspaces keep working. Re-enabling restores sign-in, and tokens revoked by the
disable stay revoked. The account-level status stays the deployment operator's
platform-wide block and is unchanged by this route; the member drawer shows it
read-only and says so. Disabling a membership that is already disabled changes
nothing and answers with the same status, and an owner whose account the
operator has blocked is not one of the active owners the last-owner rule counts,
so removing its workspace access is not held hostage by that rule.

`FD_AUTH_MFA_KEY` is rotatable. Move the retiring key into
`FD_AUTH_MFA_KEY_PREVIOUS` (comma separated, at most eight entries), put the new
one in `FD_AUTH_MFA_KEY`, and boot: stored factors keep opening, every new
enrolment is sealed with the new key, and each row records which key sealed it.
`pnpm flowdular auth secrets-rotate` counts the rows per key and
`--apply` re-seals the stale ones in batches of 200; drop the retired key once
it reports no stale rows.

Without `FD_AUTH_MFA_KEY` a workspace cannot turn on the `auth.core`
`requireMfa` setting: enrolment has no key to seal a secret with, so the
requirement would close the workspace to everyone. The write is refused with
`MFA_KEY_REQUIRED` (409), the way email confirmation is refused without a mail
transport. With the requirement on, `GET /api/settings` and
`POST /api/settings/update` stay reachable so an owner can always reverse it,
and API tokens are exempt from the enrolment gate: a service account has no
browser to enrol with, and its authority is already the intersection of its
recorded scopes with the live membership. Browser sessions stay gated, on the
API and on module web pages alike.

auth.core no longer owns the transport: it composes the invitation, password
reset and confirmation messages and hands them to the platform mail port, which
the Mail section below configures. The `FD_AUTH_*` mail variables above are the
retired spelling of the `FD_MAIL_*` ones and still work. Without a transport
(`none`) an invitation is refused with `MAIL_NOT_CONFIGURED` and a password
reset still answers generically while the server logs one warning that the
message was not delivered.

## Agents (`agents.core`)

| Variable                           | Default           | Purpose                                              |
| ---------------------------------- | ----------------- | ---------------------------------------------------- |
| `FD_AGENT_CREDENTIAL_KEY`          | generated dev key | Base64 32-byte key for the provider credential vault |
| `FD_AGENT_CREDENTIAL_KEY_PREVIOUS` | empty             | Retired credential keys, comma separated, read only  |
| `FD_AGENT_RUN_GRANT_KEY`           | generated dev key | Base64 32-byte key signing run grants                |
| `FD_AGENT_WORKER_CONCURRENCY`      | `2` (1 to 16)     | Parallel run workers                                 |
| `FD_AGENT_WORKER_LEASE_MS`         | `30000`           | Run lease before recovery reclaims it                |
| `FD_AGENT_PROVIDER_HOST_ALLOWLIST` | empty             | Hostnames an external provider may be called on      |

Outside production the keys are generated once under `.flowdular/data`. The
credential key and the run grant key are required in production: the module
refuses to boot without them. `FD_AGENT_CREDENTIAL_KEY_PREVIOUS` holds the keys
a rotation has not finished retiring: stored credentials still open under them
and nothing is written with them. `pnpm flowdular agents secrets-rotate --apply`
re-seals the stored rows; see the key rotation section of `docs/operations.md`.

## Automations (`automations.core`)

| Variable                                 | Default           | Purpose                                                |
| ---------------------------------------- | ----------------- | ------------------------------------------------------ |
| `FD_AUTOMATIONS_CREDENTIAL_KEY`          | generated dev key | Base64 32-byte key for the automation credential vault |
| `FD_AUTOMATIONS_CREDENTIAL_KEY_PREVIOUS` | empty             | Retired secret keys, comma separated, read only        |

Outside production the key is generated once under `.flowdular/data`. It is
required in production: the module refuses to boot without it.
`FD_AUTOMATIONS_CREDENTIAL_KEY_PREVIOUS` holds the keys a rotation has not
finished retiring: stored trigger secrets still open under them and nothing is
written with them. See the key rotation section of `docs/operations.md`.

## Notifications (`notifications.core`)

| Variable                               | Default           | Purpose                                            |
| -------------------------------------- | ----------------- | -------------------------------------------------- |
| `FD_NOTIFICATIONS_SECRET_KEY`          | generated dev key | Base64 32-byte key sealing webhook signing secrets |
| `FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS` | empty             | Retired secret keys, comma separated, read only    |

Outside production the key is generated once under `.flowdular/data`. It is
required in production: the module refuses to boot without it.
`FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS` holds the keys a rotation has not
finished retiring: stored webhook secrets still open under them and nothing is
written with them.

The delivery loop itself is configured through module settings, not the
environment: `retentionDays`, `retryMaxAttempts` and `retryMaxBackoffMinutes`
per workspace, `egressAllowlist` and `pollIntervalSeconds` for the platform.
Edit them in Administration, Modules.

E-mail delivery has no variable of its own. A member turns it on for their own
account under Notification preferences, and the message then leaves through the
platform mail port with the same queue, retry, backoff and dead letter a webhook
gets. With no transport composed the attempts are recorded as refused rather
than dropped, so the deliveries screen shows what was not sent.

## Connectors (`connectors.core`)

| Variable                            | Default           | Purpose                                             |
| ----------------------------------- | ----------------- | --------------------------------------------------- |
| `FD_CONNECTORS_SECRET_KEY`          | generated dev key | Base64 32-byte key sealing connector credentials    |
| `FD_CONNECTORS_SECRET_KEY_PREVIOUS` | empty             | Retired credential keys, comma separated, read only |

Outside production the key is generated once under `.flowdular/data`. It is
required in production: the module refuses to boot without it. Losing it makes
every stored connector credential unreadable, and each instance has to be given
its credential again. `FD_CONNECTORS_SECRET_KEY_PREVIOUS` holds the keys a
rotation has not finished retiring: stored credentials still open under them and
nothing is written with them.

The call bounds are module settings, not environment variables: `callTimeoutMs`
and `maxResponseBytes` for the platform. Edit them in Administration, Modules.
Which hosts an instance may reach is per instance, not per deployment.

## Audit (`audit.core`)

| Variable                       | Default       | Purpose                                                          |
| ------------------------------ | ------------- | ---------------------------------------------------------------- |
| `FD_AUDIT_BACKUP_MANIFEST`     | empty         | Path to the latest `backup.json`, or the directory holding it    |
| `FD_AUDIT_EXPORT_DIRECTORY`    | empty         | Absolute directory outside the workspace tree operator files use |
| `FD_AUDIT_ANCHOR_KEY`          | generated key | Base64 32-byte key signing audit chain anchors                   |
| `FD_AUDIT_ANCHOR_KEY_PREVIOUS` | empty         | Retired anchor keys, comma separated, verify only, at most eight |

This is how a deployment records that a backup exists. `flowdular database
backup --output <dir> --apply` writes `<dir>/backup.json`; point the variable at
that file or at `<dir>` and the retention sweep and the export read it on every
pass. Without it both are refused and the sweep ledger records `refused` with
the reason `BACKUP_MANIFEST_MISSING`, so a retention policy can never destroy
data no backup holds. Update the value after every backup: the export manifest
records the `createdAt` and the key fingerprints it found, which is the evidence
that the archive was taken while a backup existed.

`FD_AUDIT_EXPORT_DIRECTORY` is where the deployment allows an archive to be
written. An archive carries every row of one workspace, so the operator picks a
directory inside this one and nowhere else: `flowdular audit export --workspace
<slug> --output <dir> --apply` is refused with `EXPORT_DIRECTORY_NOT_CONFIGURED`
while the variable is empty, with `EXPORT_OUTPUT_NOT_ALLOWED` for a directory
outside it, and with `EXPORT_OUTPUT_INSIDE_WORKSPACE` when it points inside the
application tree, where a deployment step could commit or serve the archive by
accident. The platform creates the directories it needs with owner-only modes
and writes each archive `0600`.

**The platform must be running for an export, with or without `--apply`.** The
command records the request in the workspace and waits; the platform process is
the only one holding the sealed data class registry with every module's export
operation, so it is the process that performs the export, writes the archive and
records the run with its digest. Without `--apply` the same request is answered
as a plan: the platform counts through every owner and writes no archive. If no
platform answers within ten minutes the command stops with `EXPORT_NOT_ANSWERED`
and the run stays in the workspace's export history.

`FD_AUDIT_EXPORT_DIRECTORY` is also where `audit seal`, `audit verify` and
`audit erase` read and write. A segment file carries every audit event of a
range and a certificate names a person, so the same rule applies: the operator
picks a directory inside the allowed one, never inside the application tree.

`FD_AUDIT_ANCHOR_KEY` signs the anchor of every sealed segment with
HMAC-SHA256, which is what proves a segment file was closed by this deployment
and not by whoever holds the file. It is required in production. Outside
production the platform generates a random 32-byte key on first use and keeps it
in the local data directory, so anchors sealed yesterday still verify today; it
is not derived from anything, and losing that file loses the ability to verify
the anchors it signed. `FD_AUDIT_ANCHOR_KEY_PREVIOUS` holds the keys a rotation
has not finished retiring, comma separated: they verify anchors already written
and sign nothing. At most eight of them are accepted, the same bound the shared
keyring enforces; a longer list is a rotation that was never finished and the
platform refuses to start with it. See Key rotation in `docs/operations.md`.

The sweep itself is configured through platform module settings, not the
environment: `sweepIntervalMinutes` (5 to 1440, default 60) and `sweepBatchSize`
(50 to 5000, default 500). Edit them in Administration, Modules. The batch size
is read on every pass; the interval is armed when the platform starts, so a new
cadence applies at the next start.

### Sealing, legal holds and erasure

Three operator commands, all dry runs without `--apply`:

```bash
flowdular audit seal --workspace <slug> --output <dir> [--apply]
flowdular audit verify --workspace <slug> --input <dir>
flowdular audit erase --workspace <slug> --account <id> --output <dir> \
  [--apply --confirm erase-subject] [--destroy-key]
```

`audit seal` closes a segment of the workspace's audit event chain: every event
after the last anchor, written as JSON Lines with the anchor as the first line
of the file and recorded in the workspace as well. The anchor carries the
sequence range, the row count, the time range, the hash chain over the segment
continuing from the previous anchor, and a signature. Sealing itself writes an
audit event, so each run leaves exactly one link for the next one.

`audit verify` reads the segment files a directory holds for that workspace,
recomputes every event hash and the segment chain, checks each anchor signature
and the links between anchors, and names the first line and anchor that do not
match. One directory may hold the segments of several workspaces: a verification
reads the files named after the one it was asked about and skips the rest. It
reports how many events in those segments carry no event format, which are the
ones written before audit.core sealed anything and therefore may carry an actor,
a subject and details in the clear; an event about nobody is not one of them.

Retention removes an audit event only once a segment file holds it. A sweep of
`audit.core.events` that finds older events above the newest anchor is recorded
`refused` with the reason `SEGMENT_NOT_SEALED` and removes none of them, so a
chain is never aged faster than it is archived. Archiving a segment to S3 is out
of scope; the deployment's own directory is the archive.

A legal hold is a per-workspace row an owner holding `audit.holds.manage` places,
lists and lifts, in Administration, Legal holds or through
`flowdular audit holds list|place|lift`. It names an account, the workspace, a
data class or a date range, optionally narrowed by several of them together, and
carries the reason it was placed and the reason it was lifted; both are written
to the audit trail. A hold names the account it covers and the matter behind it,
so `audit.registry.read` does not reach the list: all three operations need
`audit.holds.manage`. While a hold stands, the retention sweep and erasure refuse
for everything it covers with the stable code `HOLD_ACTIVE`, and the sweep
ledger records the refusal per class with the rows held back where audit.core
owns the class and can count them. A hold that names rows rather than a class
withholds the whole class of that workspace, because the module sweep contract
carries no row predicate; a hold never withholds less than it covers.

`audit erase` walks the sealed data class registry and removes one subject's
records from every class whose declaration carries an erase operation. It is
refused under a hold; without `--apply` it lists what would be erased per module
and class, and a class that cannot count says so rather than guessing. Every
class of the registry appears in the plan and on the certificate, and one that
declares no erase is named `not-erasable` rather than left out. With `--apply`
it needs `--confirm erase-subject`, runs each class inside the owning module's
own transaction, writes an audit event before and after, and writes a JSON
certificate naming the workspace, the subject, every class with its outcome and
count, the operator and the newest anchor. A class that reports rows left behind
leaves the certificate incomplete and the run recorded `partial`. **The platform
must be running**, as for an export: only the platform process holds the sealed
registry with every module's erase operation, so the command records the request
and waits for it; a request nothing answers within 24 hours is recorded failed
with `ERASURE_REQUEST_EXPIRED`.

A module offers a class for erasure by declaring it on the data class it already
declares, next to `sweep` and `export`:

```ts
context.dataClasses.declare('agents.core', [
	{
		key: 'runs',
		label: 'Agent runs',
		defaultRetentionDays: 90,
		exportable: true,
		sweep: ({ tenantId, cutoff, limit }) => /* ... */,
		export: ({ tenantId, sink }) => /* ... */,
		erase: async ({ tenantId, subject, limit }) => {
			const removed = await repository.deleteRunsOf(
				tenantId,
				subject.accountId,
				limit,
			);
			return { removed, truncated: removed === limit };
		},
		count: ({ tenantId, subject }) =>
			repository.countRunsOf(tenantId, subject.accountId),
	},
]);
```

Both members are optional and both run inside the declaring module, on its own
leases and its own tenant transaction. `erase` removes at most `limit` rows and
answers how many it removed, with `truncated` when rows of the subject are left
for the next call; audit.core repeats the call until one answers fewer than the
batch or the batch cap is reached. `count` answers how many rows the subject
holds, or `null` when the module cannot say cheaply. The public capability
`audit.erasure.v1` carries the same two operations for a module that composes
after audit.core and prefers to register `{ moduleId, classId, erase, count? }`
instead; where a class has both, the declaration wins.

Audit events themselves are never erased: they are the evidence the data
lifecycle happened, and retention bounds them instead. From 0.2.0 an audit event
that names a person seals the actor, the subject and the details under that
person's data key in `audit_subject_keys`, and the event hash covers the sealed
bytes, so `audit erase --destroy-key` makes those fields unreadable for ever
while the chain still verifies. A destroyed key is never recreated: the key row
keeps a marker that outlives the account, so a later event about that subject is
written under the marker and a write that would create a second key is refused
with `SUBJECT_KEY_DESTROYED`. Events written before the event format marker stay
in the clear and `audit verify` reports them as such.

What a workspace can set a period for is what the composed modules declared. The
classes and the defaults they ship with:

| Class                                | Default retention | Swept | Exported | Erasable |
| ------------------------------------ | ----------------- | ----- | -------- | -------- |
| `agents.core.runs`                   | 90 days           | yes   | yes      | yes      |
| `agents.core.audit-events`           | kept              | no    | yes      | no       |
| `agents.core.provider-credentials`   | kept              | no    | no       | no       |
| `approvals.core.requests`            | 400 days          | yes   | yes      | yes      |
| `audit.core.events`                  | 400 days          | yes   | yes      | no       |
| `audit.core.sweep-runs`              | 400 days          | yes   | yes      | no       |
| `audit.core.export-runs`             | 400 days          | yes   | yes      | no       |
| `audit.core.legal-holds`             | kept              | no    | yes      | no       |
| `audit.core.erasure-runs`            | kept              | no    | yes      | no       |
| `audit.core.anchors`                 | kept              | no    | no       | no       |
| `audit.core.subject-keys`            | kept              | no    | no       | no       |
| `auth.core.sessions`                 | 30 days           | yes   | yes      | yes      |
| `auth.core.api-tokens`               | 400 days          | yes   | yes      | yes      |
| `auth.core.audit-events`             | 400 days          | yes   | yes      | no       |
| `automations.core.audit-events`      | kept              | no    | yes      | no       |
| `connectors.core.calls`              | 400 days          | yes   | yes      | no       |
| `connectors.core.audit`              | kept              | no    | yes      | no       |
| `connectors.core.instances`          | kept              | no    | yes      | no       |
| `directory.core.provisioning-events` | 365 days          | yes   | yes      | no       |
| `documents.core.documents`           | kept              | no    | yes      | no       |
| `import.core.jobs`                   | 180 days          | yes   | yes      | no       |
| `metering.core.buckets`              | 400 days          | yes   | yes      | no       |
| `notifications.core.inbox`           | 365 days          | yes   | yes      | no       |
| `notifications.core.deliveries`      | 30 days           | yes   | yes      | no       |
| `search.core.recent-queries`         | 90 days           | yes   | yes      | no       |
| `workflows.core.runs`                | 90 days           | yes   | yes      | yes      |
| `workflows.core.audit-events`        | kept              | no    | yes      | no       |
| `workflows.core.definitions`         | kept              | no    | yes      | no       |

"Kept" means the rows leave only when a person or the owning module deletes
them. "Erasable" means the class declares `erase` for a subject account; a class
without it is named as not erasable on every erasure certificate. A hash-chained trail is aged only once it is archived: removing links no
segment file holds would make the next verification indistinguishable from
tampering, so the sweep of `audit.core.events` stops at the newest anchor and
refuses the rest with `SEGMENT_NOT_SEALED`, while `automations.core` keeps its
chain until chain archival ships. A sweep never
removes a row that is still in use: a live session, a token that still
authenticates and a delivery attempt that has not completed stay whatever their
age. The periods above are defaults; Administration, Audit sets the workspace's
own.

## Workflows (`workflows.core`)

| Variable                            | Default         | Purpose                                           |
| ----------------------------------- | --------------- | ------------------------------------------------- |
| `FD_WORKFLOWS_PAYLOAD_KEY`          | derived dev key | Base64 32-byte key encrypting run payloads        |
| `FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS` | empty           | Retired payload keys, comma separated, read only  |
| `FD_WORKFLOWS_CURSOR_KEY`           | derived dev key | Base64 32-byte key signing execution cursors      |
| `FD_WORKFLOWS_CURSOR_KEY_PREVIOUS`  | empty           | Retired cursor keys, comma separated, verify only |

Both current keys are required in production. The `_PREVIOUS` lists hold the
keys a rotation has not finished retiring: stored payloads still open and
outstanding cursors still verify under them, while every new payload is sealed
and every new cursor signed with the current key. Cursors are never stored, so a
cursor key needs no re-signing pass. See the key rotation section of
`docs/operations.md`.

## Mail

One outbound transport serves the whole deployment. Modules never select one:
they receive the mail port on the server context (`context.mail`) and hand it a
bounded message. auth.core sends invitations, password resets and confirmations
through it, and notifications.core mails an inbox item to a member who asked
for it.

| Variable                               | Default | Purpose                                                                               |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `FD_MAIL_TRANSPORT`                    | `none`  | `none`, `development` or `smtp`; `development` is refused in production               |
| `FD_MAIL_SMTP_URL`                     | none    | `smtp://` or `smtps://` relay URL with credentials; required by the `smtp` transport  |
| `FD_MAIL_FROM`                         | none    | Sender as `Name <address>` or `address`; required by the `smtp` transport             |
| `FD_MAIL_SMTP_TLS_REJECT_UNAUTHORIZED` | `true`  | Verify the relay certificate                                                          |
| `FD_MAIL_SMTP_REQUIRE_TLS`             | `true`  | Demand STARTTLS on the cleartext `smtp://` scheme; `false` allows a plaintext session |

Each variable falls back to the auth.core name it replaces
(`FD_AUTH_MAIL_TRANSPORT`, `FD_AUTH_SMTP_URL`, `FD_AUTH_MAIL_FROM`,
`FD_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED`, `FD_AUTH_SMTP_REQUIRE_TLS`, and
`FD_AUTH_DEVELOPMENT_MAIL=true` for `FD_MAIL_TRANSPORT=development`). A
deployment on the old names keeps working and the server logs one
`deprecated mail variable` line per retired key it read, naming the
replacement. The platform name wins when both are set, and every refusal names
the variable the deployment actually set.

`none` refuses every message with `MAIL_NOT_CONFIGURED` and sends nothing.
`development` keeps the last 100 messages in memory for a local run and a test
and is refused at boot in production, where it would be silent data loss.
`smtp` connects with a 10 second connection and greeting timeout and sends the
plain-text and HTML parts together. `FD_MAIL_SMTP_URL` carries the relay
password, so it belongs in the same secret store as the encryption keys; it is
never logged. Its user and password are percent-decoded, so any reserved
character in them, `%` included, must be percent-encoded or the boot stops on
`FD_MAIL_SMTP_URL credentials must be percent-encoded.` The cleartext `smtp://`
scheme (port 587 by default) starts in the open and is upgraded by STARTTLS, so
`FD_MAIL_SMTP_REQUIRE_TLS` defaults to `true` and the relay has to offer the
upgrade; `smtps://` is already encrypted end to end and ignores the variable.

Every message is bounded before a transport sees it: at most 16 recipients, a
200 character single-line subject, 64 KB of text, 256 KB of HTML, at most 16
extra headers whose names the envelope does not own, and no CR or LF anywhere a
header could be opened. A message that breaks a bound is refused with
`MAIL_MESSAGE_REJECTED` before the connection opens, and a relay failure
reaches the sender as `MAIL_DELIVERY_FAILED` carrying nothing the relay said.

## Storage

Objects (attachments, documents, images) live outside PostgreSQL, so tenant
isolation there is the key layout rather than row-level security: every key is
`<tenantId>/<moduleId>/<objectId>` and the tenant id comes from the
authenticated principal, never from a request. Every object is encrypted with
AES-256-GCM before it is written, and its metadata is authenticated with it, so
an object moved into another tenant's prefix does not open.

| Variable                             | Default                             | Purpose                                                                      |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------- |
| `FD_STORAGE_ADAPTER`                 | `s3` in production, else `local`    | `local` or `s3`; `local` is refused in production                            |
| `FD_STORAGE_LOCAL_DIRECTORY`         | `.flowdular/data/storage`           | Object directory of the local adapter                                        |
| `FD_STORAGE_S3_BUCKET`               | none                                | Bucket name; required by the S3 adapter                                      |
| `FD_STORAGE_S3_REGION`               | none                                | Signing region; required by the S3 adapter                                   |
| `FD_STORAGE_S3_ENDPOINT`             | `https://s3.<region>.amazonaws.com` | Endpoint for MinIO, R2 or another S3-compatible store                        |
| `FD_STORAGE_S3_ACCESS_KEY_ID`        | none                                | Access key id; required by the S3 adapter                                    |
| `FD_STORAGE_S3_SECRET_ACCESS_KEY`    | none                                | Secret access key; required by the S3 adapter                                |
| `FD_STORAGE_S3_FORCE_PATH_STYLE`     | `false`                             | `<endpoint>/<bucket>/<key>` instead of a bucket subdomain                    |
| `FD_STORAGE_MAX_OBJECT_BYTES`        | `26214400` (25 MiB)                 | Per-object limit, 1024 to 268435456; a stream is cut off at it               |
| `FD_STORAGE_ENCRYPTION_KEY`          | derived dev key                     | Base64 32-byte key sealing every object and read URL; required in production |
| `FD_STORAGE_ENCRYPTION_KEY_PREVIOUS` | empty                               | Retired object keys, comma separated, read only                              |

A module writes through `context.storage` and never sees an adapter, a bucket or
a path. Only these content types are stored, and the bytes are verified against
the declared type before the write: PDF, PNG, JPEG, GIF, WebP, plain text, CSV,
the three OOXML documents (`.docx`, `.xlsx`, `.pptx`) and the two legacy Office
formats. Archives and executables are refused, and an archive renamed to
`.xlsx` is refused too, because an OOXML file has to carry
`[Content_Types].xml` as its first entry. A malware scanner is a seam rather
than a shipped feature: without one every object is stored with the verdict
`unscanned`, and a scanner that answers `infected` refuses the write.

`storage.readUrl(...)` returns `/api/storage/objects/<token>`, a platform route
rather than a presigned object-store URL, because the stored bytes are
ciphertext. The token is the capability: it is sealed under the storage keyring,
carries the tenant, module, object and an expiry of at most one hour, and needs
no session. The route answers 404 for an expired, forged or unknown token
alike, sends `content-disposition: attachment` with
`cache-control: private, no-store`, and is limited to 600 reads a minute per
caller.

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
in every empty value: every encryption key above, including the connectors
and audit anchor keys, the object store settings and the four PostgreSQL role
passwords. See [../infra/README.md](../infra/README.md).
