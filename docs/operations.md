# Operations

The runbook for a deployed Flowdular application: backing the data up, getting
it back, what key rotation does today, what to check before a release, and how
to roll one back. Environment variables are documented in
[configuration.md](configuration.md); the deployment itself in
[../infra/README.md](../infra/README.md).

## Backup

```bash
flowdular database backup --output /backups/flowdular/2026-09-11          # plan
flowdular database backup --output /backups/flowdular/2026-09-11 --apply  # write
```

Like every write command it is a dry run without `--apply`: it prints the
adapter, the source it would read, the files it would write and the manifest,
and touches nothing. The target directory must not already hold a `backup.json`,
so a backup never overwrites another one.

A backup directory holds two things:

| File                         | Contents                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `backup.json`                | Timestamp, adapter, platform version, enabled modules, key fingerprints       |
| `database.dump` or `pglite/` | The `pg_dump` custom-format archive, or a copy of the embedded data directory |

The command creates the directory with mode `0700` and writes `backup.json` and
`database.dump` with `0600`, so a dump is not readable by every account on the
host. A directory that already exists keeps the mode it was made with: when the
backup target is a mount or a path an earlier run created, check its mode
yourself. The same goes for `pglite/`, which is copied file by file and keeps
the modes of the source data directory.

**PostgreSQL.** The command runs `pg_dump --format=custom` with the migrator
connection of the configured environment (`FD_DATABASE_MIGRATOR_URL`, else
`FD_DATABASE_URL`). The credentials reach the child process as `PG*` variables,
never as arguments, so no password lands in the host's process list, and the
child inherits none of the platform's encryption keys. `FD_DATABASE_TLS` and
`FD_DATABASE_TLS_CA[_FILE]` are translated into `PGSSLMODE` and `PGSSLROOTCERT`,
so a `verify-full` deployment is dumped over a verified connection. Without the
client tools on `PATH` the command fails with `BACKUP_TOOL_MISSING`; install the
PostgreSQL client package matching the server version.

**Embedded PGlite.** Outside production the database is a directory
(`FD_DATABASE_PGLITE_DIRECTORY`, by default `.flowdular/data/pglite`), and the
command copies it. Stop the application first. A copy taken while the process is
writing can hold a torn state, and the command says so in a warning.

### What a backup does not contain

> **The encryption keys live outside the database.** Store every key with the
> backup. A restore without them yields unreadable credentials and workflow
> payloads: the rows come back, the values inside them stay ciphertext forever.

`backup.json` records, for each key, a SHA-256 fingerprint of the key material
and never the material itself:

```json
{
	"schemaVersion": 1,
	"createdAt": "2026-09-11T09:30:00.000Z",
	"adapter": "postgresql",
	"platformVersion": "0.2.0",
	"modules": ["agents.core", "auth.core", "workflows.core"],
	"keys": [
		{
			"variable": "FD_AGENT_CREDENTIAL_KEY",
			"fingerprint": "sha256:0f1e..."
		},
		{ "variable": "FD_AUTH_MFA_KEY", "fingerprint": null }
	]
}
```

The ten keys are `FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`,
`FD_WORKFLOWS_PAYLOAD_KEY`, `FD_WORKFLOWS_CURSOR_KEY`, `FD_AUTH_MFA_KEY`,
`FD_AUTOMATIONS_CREDENTIAL_KEY`, `FD_NOTIFICATIONS_SECRET_KEY`,
`FD_STORAGE_ENCRYPTION_KEY`, `FD_CONNECTORS_SECRET_KEY` and
`FD_AUDIT_ANCHOR_KEY`. A `null` fingerprint means the key was not set
when the backup was taken. Keep the key material in the secret store the
deployment already uses, and record which backup it belongs to; the fingerprint
is what lets a restore tell you whether the pair matches.

Without `FD_AUDIT_ANCHOR_KEY` a restored deployment cannot verify the anchors
it holds, and every sealed segment file becomes a file whose origin nobody can
prove, so treat its fingerprint like the others.

The per-subject audit keys live in `audit_subject_keys` inside the database, so
a database backup carries them. A backup taken before
`flowdular audit erase --destroy-key` still holds the key that run destroyed, so
restoring it makes those sealed fields readable again. Treat an erasure as a
reason to age out the backups that predate it, as you would for any other
deletion on request. The key row itself survives destruction as a tombstone
carrying the subject's marker, which is what stops a later event about that
subject from creating a second key and putting the account back in the clear.

### Schedule

- Dump before every rollout, and on a daily schedule between them.
- Keep the archive off the database host, and keep the keys in the secret store,
  not next to the dump.
- Keep one restore rehearsal in the calendar. A backup nobody has restored is a
  guess; restoring into a scratch database is the only proof.
- Retention follows the data policy of the business, not this document. Delete
  old keys only after the dumps they unlock are gone.

## Restore

```bash
flowdular database restore --input /backups/flowdular/2026-09-11            # plan
flowdular database restore --input /backups/flowdular/2026-09-11 --apply --confirm restore-database
```

The plan reports the manifest, the payload it would read and one key comparison
per variable. When the running environment holds keys the backup was not taken
with, the envelope carries a `BACKUP_KEY_MISMATCH` warning naming each variable
and how it differs (`different`, `missing-in-environment`, `missing-in-backup`).
Restore the keys before the data, or the rows arrive unreadable.

The order that works:

1. Stop the application, or take it out of the load balancer.
2. Put the keys the backup was taken with into the environment.
3. Run the restore as a dry run and read the key comparison.
4. Run it with `--apply --confirm restore-database`.
5. Start the application, then check `pnpm flowdular migration verify` and
   `GET /api/ready`.

PostgreSQL restores run `pg_restore --clean --if-exists` against the migrator
connection, so the target database must already exist and its roles must already
be there. The embedded adapter is replaced directory by directory: the copy is
staged next to the target and the old directory is removed only once the new one
is in place, so a failed copy leaves the running database untouched.

`database restore` is a destructive capability, gated exactly like
`database reset`: the runner refuses it with `LOCAL_ONLY_CAPABILITY` unless
`FD_ENV` or `NODE_ENV` is `development` or `test`. Production restores therefore
run `pg_restore --clean --if-exists` by hand with the migrator credentials, and
the dry run on a staging copy of the same backup is what proves the archive and
the keys are good. Lifting that restriction waits on the signed approval
verifier listed under `planned` in `.ai/policies/capabilities.yaml`.

## Key rotation

Most of the keys carry a key id in every envelope they write, so a
deployment can hold the new key and the old one at the same time and re-seal the
stored rows in place. The others have no key id and are covered at the end of
this section.

Every module reads one current key plus an optional comma-separated list of
retired keys (up to eight):

| Key                             | Protects                   | Retired keys                             | Re-sealing the stored rows                              |
| ------------------------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `FD_AGENT_CREDENTIAL_KEY`       | Agent provider credentials | `FD_AGENT_CREDENTIAL_KEY_PREVIOUS`       | `pnpm flowdular agents secrets-rotate [--apply]`        |
| `FD_AUTOMATIONS_CREDENTIAL_KEY` | Automation trigger secrets | `FD_AUTOMATIONS_CREDENTIAL_KEY_PREVIOUS` | `pnpm flowdular automations secrets-rotate [--apply]`   |
| `FD_WORKFLOWS_PAYLOAD_KEY`      | Workflow run payloads      | `FD_WORKFLOWS_PAYLOAD_KEY_PREVIOUS`      | `pnpm flowdular workflows secrets-rotate [--apply]`     |
| `FD_STORAGE_ENCRYPTION_KEY`     | Stored objects             | `FD_STORAGE_ENCRYPTION_KEY_PREVIOUS`     | No re-sealing pass yet; see the storage note below      |
| `FD_NOTIFICATIONS_SECRET_KEY`   | Webhook signing secrets    | `FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS`   | `pnpm flowdular notifications secrets-rotate [--apply]` |
| `FD_CONNECTORS_SECRET_KEY`      | Connector credentials      | `FD_CONNECTORS_SECRET_KEY_PREVIOUS`      | No re-sealing pass yet; the ring reads the previous key |
| `FD_AUDIT_ANCHOR_KEY`           | Audit chain anchors (HMAC) | `FD_AUDIT_ANCHOR_KEY_PREVIOUS`           | `pnpm flowdular audit secrets-rotate [--apply]`         |

These commands run the same re-sealing pass over their own table, so the
procedure is the same for each. The credential key is the worked example;
substitute the key names and the command from the row you are rotating:

1. Generate the new key: `openssl rand -base64 32`.
2. Set the new key as the current one and the old key as the retired one:
   `FD_AGENT_CREDENTIAL_KEY=<new>` and `FD_AGENT_CREDENTIAL_KEY_PREVIOUS=<old>`.
   Keep both in the secret store, exactly like the key they replace.
3. Deploy. From this moment every write uses the new key and every stored row
   still opens under the old one, so nothing is unreadable while the rollout
   completes.
4. Run the rotation as a dry run and read the counts per key id:
   `pnpm flowdular agents secrets-rotate --json`. `stale` is the number of rows
   still sealed with a retired key.
5. Run it again with `--apply`. It re-seals rows in batches of 200, one
   transaction per batch, scoped to the tenant that owns them, and writes nothing
   else: the revision, the audit fields and the credential a caller sees do not
   change. It is idempotent, so running it twice is free.
6. Repeat the dry run until it reports `stale: 0`, then remove
   `FD_AGENT_CREDENTIAL_KEY_PREVIOUS` and deploy again.

The application may stay up. Each row is written back only if its stored
envelope is still the one that was read, so a credential the application
rewrites in between is never clobbered: the rotation counts it under `skipped`
and the next run picks it up. Stopping the application removes that case
entirely. The inventory that finds the stale rows runs on the cross-tenant
read-only role, which is granted the tenant id and the key id and cannot read a
nonce, a tag or a ciphertext; every row it names is read again under its own
tenant before it is touched.

`FD_AUDIT_ANCHOR_KEY` follows the same six steps with one difference: an anchor
is signed, not sealed, so the rotation rewrites the signature and the key id and
touches neither the anchor hash, the segment hash nor the chain. A segment file
written under the retired key keeps its own signature and still verifies while
that key is in `FD_AUDIT_ANCHOR_KEY_PREVIOUS`. Keep the retired key until every
archived segment has been verified once under the new one, with
`pnpm flowdular audit verify --workspace <slug> --input <dir>` over the archive.
If the rotation reports `ANCHOR_KEY_UNKNOWN`, anchors exist that neither key can
re-sign: put that key back before retiring it, because a signature nobody can
reproduce can never be verified again. The rotation verifies an anchor's stored
signature under the ring before re-signing it, so `ANCHOR_SIGNATURE_INVALID`
names anchors it left exactly as they are: a new signature over the same anchor
hash would replace evidence nobody can account for with one this deployment
vouches for. Verify the segment files of those anchors before anything else.
`FD_AUDIT_ANCHOR_KEY_PREVIOUS` accepts at most eight retired keys; a longer list
is a rotation that was never finished and the platform refuses to start.

The remaining keys, and how rotation behaves for each:

| Key                       | Protects                               | Rotating it                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FD_WORKFLOWS_CURSOR_KEY` | Pagination cursors (HMAC)              | Safe. `FD_WORKFLOWS_CURSOR_KEY_PREVIOUS` keeps outstanding cursors valid; cursors are never stored, so there is nothing to re-sign.                                                                                                                          |
| `FD_AGENT_RUN_GRANT_KEY`  | Agent run grant tokens (HMAC, 30s TTL) | Safe. In-flight grants fail for the length of one TTL.                                                                                                                                                                                                       |
| `FD_AUTH_MFA_KEY`         | Enrolled TOTP secrets                  | Supported since auth.core 0.11.0. Set `FD_AUTH_MFA_KEY_PREVIOUS`, deploy, run `pnpm flowdular auth secrets-rotate --apply`, then drop the previous key. Rows written before the key id column exist open through the ring fallback until they are re-sealed. |

The key ids are derived from the key material, so a backup fingerprint that
matches the environment also matches the `keyId` inside the rows. The keys that
carry no id are the ones a restore cannot diagnose for you, which is why
`backup.json` records a fingerprint for all eight.

Sources: `modules/audit/src/services/{anchor-key,anchor-rotation}.ts`,
`packages/kernel/src/keyring.ts`,
`modules/agents/src/services/{credential-vault,credential-rotation}.ts`,
`modules/automations/src/services/{secret-vault,secret-rotation}.ts`,
`modules/workflows/src/services/{payload-codec,payload-rotation,cursor-codec}.ts`,
`modules/notifications/src/services/{secret-vault,secret-rotation}.ts`,
`modules/auth/src/services/totp.ts`.

## Storage

Objects live outside PostgreSQL, so a database backup does not contain one. Back
up the object store the same way you back up the database, and take both at the
same point: a restored database that references objects a newer bucket snapshot
no longer holds leaves dangling references, and the reverse leaves orphans.

- **S3-compatible store.** Enable versioning and a lifecycle policy on the
  bucket, or replicate it. `backup.json` does not reach into it.
- **Local adapter.** Development and test only, refused in production. Its
  directory is `FD_STORAGE_LOCAL_DIRECTORY`, by default
  `.flowdular/data/storage`; stop the application before copying it.

Every object is sealed with AES-256-GCM under `FD_STORAGE_ENCRYPTION_KEY`, and
the key id is stored with the object, so a rotation runs like the four above:
put the retired key in `FD_STORAGE_ENCRYPTION_KEY_PREVIOUS`, deploy, and every
object written earlier still opens while new ones use the current key. There is
no re-sealing pass yet, so keep the retired key in the ring until every object
written under it has been rewritten or deleted. Dropping it makes those objects
unreadable, exactly as a lost database key makes a credential unreadable.

## Logs

The server writes one line per event through `createLogger`
(`packages/server/src/log.ts`).

| Variable        | Default                           | Purpose                                          |
| --------------- | --------------------------------- | ------------------------------------------------ |
| `FD_LOG_FORMAT` | `json` in production, else `text` | `json` for a log pipeline, `text` for a terminal |
| `FD_LOG_LEVEL`  | `info`                            | `debug`, `info`, `warn` or `error`               |

A JSON line carries `time`, `level`, `msg` and, where they apply, `requestId`,
`endpoint`, `module` and `err` (name and message). Stacks are written outside
production, and in production only at `FD_LOG_LEVEL=debug`. The `requestId` is
the same value the response returns in `x-request-id`, so a user-reported error
id finds its log line. Credential-shaped field names (`authorization`, `cookie`,
`password`, `token`, `secret`, `credential`, API keys) are redacted before a
line is written, and a failing endpoint logs its id and the error type only,
never the message, the body or the URL. An unrecognized value for either
variable falls back to the default and logs one warning about it.

## Production checklist

- `pnpm verify` and `pnpm build` pass on the commit being shipped.
- `FD_ENV=production`, `FD_DATABASE_ADAPTER=postgresql`, separate
  `FD_DATABASE_URL` and `FD_DATABASE_MIGRATOR_URL` roles, neither `SUPERUSER`
  nor `BYPASSRLS` on the runtime role.
- `FD_DATABASE_TLS=verify-full` with `FD_DATABASE_TLS_CA` or
  `FD_DATABASE_TLS_CA_FILE`. Production accepts nothing weaker.
- All six encryption keys set, held in the secret store, and backed up with a
  recorded fingerprint.
- `FD_AUTH_SECURE_COOKIE` on, `FD_AUTH_PUBLIC_ORIGIN` equal to the public URL,
  `FD_TRUST_PROXY` set behind a proxy, sign-up closed unless the deployment is
  public.
- Mail transport configured: `FD_AUTH_MAIL_TRANSPORT` with `FD_AUTH_SMTP_URL`
  and `FD_AUTH_MAIL_FROM`. Password resets, invitations and address
  confirmations are silently undeliverable without it.
- Migrations at rollout: deploy the image, let it apply its module migrations
  under the migrator role, then `pnpm flowdular migration verify`. Never edit an
  applied `.up.sql`.
- Liveness probe on `GET /api/health`, readiness probe on `GET /api/ready`.
- `FD_LOG_FORMAT=json` and a log pipeline that keeps `requestId`.
- A fresh backup, taken and verified before the rollout starts.

## Rollback

1. Redeploy the previous image tag. Module migrations are additive, so an older
   image runs against a newer schema and ignores columns it does not know.
2. Never apply a `.down.sql` to roll back a release. They document the reverse
   for review; against live data they are data loss.
3. To take one module out of service, `pnpm flowdular module disable <id> --apply`,
   rebuild the composition and redeploy. Its tables stay where they are.
4. If the rollback is about a key, restore the key first. A previous image does
   not make ciphertext readable again.
5. Restore from a backup only when the schema or the data is actually damaged.
   It is the slowest option and the only one that loses everything written since
   the dump.

## Metrics

`GET /api/metrics` serves Prometheus text exposition, format version 0.0.4. The
route is composed only when `FD_METRICS=true`; with `FD_METRICS_TOKEN` set, a
scrape must send `Authorization: Bearer <token>` and gets 401 without it.

**An untokened `/api/metrics` must never be reachable outside the scrape
network.** It shares the application port, so without `FD_METRICS_TOKEN` every
client that can reach the port reads the series, including the endpoint
inventory and the request rates of the whole deployment. Either set the token
(the Kubernetes manifests read it from the deployment Secret, optional so it
can be left unset deliberately) or keep the port on a network only the scraper
reaches. Do not rely on the route being obscure.

| Series                                    | Type      | Labels                              |
| ----------------------------------------- | --------- | ----------------------------------- |
| `flowdular_http_requests_total`           | counter   | `endpoint`, `method`, `status`      |
| `flowdular_http_request_duration_seconds` | histogram | `endpoint`, buckets 0.005 s to 10 s |
| `flowdular_metrics_dropped_samples_total` | counter   | none                                |
| `flowdular_process_start_time_seconds`    | gauge     | none                                |
| `process_resident_memory_bytes`           | gauge     | none                                |
| `nodejs_eventloop_lag_seconds`            | gauge     | none                                |
| `flowdular_build_info`                    | gauge     | `version`                           |

`endpoint` is the endpoint id, never the request path, so a record id cannot
reach a label. `status` is the class (`2xx`, `4xx`, `5xx`), and an unrecognized
method is recorded as `other`. No session, tenant or user value is ever a label.

`nodejs_eventloop_lag_seconds` is the mean delay over the interval since the
previous scrape, not since the process started, so a spike shows up in the
scrape that follows it and is gone from the next one. The sampler is
process-wide and is drained on every read, so two scrapers pointed at the same
process split the samples between them; point one scraper at it.

Every request through `defineEndpoint` is recorded, whether or not the route is
exposed, so a scraper enabled later sees the counters immediately. Memory is
bounded: the process keeps at most 2000 distinct label sets per series family
and refuses new ones after that, counting each refusal in
`flowdular_metrics_dropped_samples_total`. A non-zero value there means a
deployment composes more endpoints than the ceiling allows.
