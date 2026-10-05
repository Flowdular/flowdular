# Vercel deployment

Flowdular runs on Vercel as two Node.js Functions built from one server bundle.
The `vercel.json` build command builds Octane, then writes a Build Output API
artifact:

- `functions/flowdular.func` serves HTTP with `FD_RUNTIME_ROLE=web`. It never
  starts a module worker and never claims queued work.
- `functions/worker.func` runs with `FD_RUNTIME_ROLE=tick` and answers only
  `/api/internal/worker/tick`. Each tick starts every module worker, keeps them
  running for one window and drains them before it answers.
- `static` holds the public client assets. Pages stay behind Octane's
  authentication.

Two things tick the worker Function:

- Vercel Cron calls the tick path every minute with a 50 second window
  (`FD_WORKER_TICK_WINDOW_MS`). Scheduled work and recovery of interrupted jobs
  run there.
- After a state-changing `/api` request answers with a success status, the web
  Function asks for a 15 second tick, so work a member just queued (an agent
  run, a render, a notification) starts within seconds instead of waiting for
  the next cron run. Repeated requests on one instance ask at most once every
  5 seconds, and a tick arriving while a window is open joins it.

Both callers present `CRON_SECRET` as a bearer token; the worker Function reads
it as `FD_WORKER_TICK_SECRET`. Without a secret of at least 32 characters the
worker Function refuses to boot.

## Plans

Vercel Hobby accepts at most one cron run a day and fails a deployment whose
schedule is tighter. Set `FD_VERCEL_CRON_SCHEDULE` (for example `0 3 * * *`) for
the build on a Hobby team. Work queued by a request still starts at once, but a
scheduled automation then fires only when a request or the daily run ticks the
worker. Pro runs the default `* * * * *` schedule.

Cron runs only on the production deployment. A preview deployment ticks only
from its own requests, and only when Deployment Protection lets the request
through: enable Protection Bypass for Automation so the web Function can send
`VERCEL_AUTOMATION_BYPASS_SECRET`.

## Before the first deployment

1. Provision PostgreSQL with separate runtime, background and migrator roles.
   Runtime and background must hold neither `SUPERUSER` nor `BYPASSRLS`. Use
   verified TLS and a connection pooler suitable for many short-lived instances.
2. Provision object storage: a private Vercel Blob store
   (`FD_STORAGE_ADAPTER=vercel-blob`) or an S3-compatible bucket.
3. Generate and back up the stable 32-byte platform keys listed in the
   production `.env.example` or `render.yaml`. Changing a key against existing
   rows makes data unreadable.
4. Run first-run setup against that database from a temporary local or container
   instance and create the workspace and owner. The Vercel Functions refuse an
   empty or unconfigured database because their filesystem cannot keep a setup
   token or `.env`.

## Vercel configuration

Run `pnpm flowdular deploy plan vercel` first. The plan's URL creates a new
Vercel project by cloning the pushed branch; to connect an existing project, use
`vercel link` and `vercel deploy`. Keep the project root at the repository root
and select Node.js 24. The output is inspectable locally with
`node infra/vercel/build.mjs --package-only` after `pnpm build`.

Set these environment variables for each environment you deploy:

| Group          | Variables                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database       | `FD_DATABASE_ADAPTER=postgresql`, `FD_DATABASE_URL`, `FD_DATABASE_BACKGROUND_URL`, `FD_DATABASE_MIGRATOR_URL`, `FD_DATABASE_TLS=verify-full`, and `FD_DATABASE_TLS_CA` or `FD_DATABASE_TLS_CA_FILE` when the server certificate is not publicly trusted                                                |
| Object storage | `FD_STORAGE_ADAPTER=vercel-blob` with a connected private Blob store, or `FD_STORAGE_ADAPTER=s3` with `FD_STORAGE_S3_BUCKET`, `FD_STORAGE_S3_REGION`, `FD_STORAGE_S3_ACCESS_KEY_ID`, `FD_STORAGE_S3_SECRET_ACCESS_KEY`; `FD_STORAGE_MAX_OBJECT_BYTES=4194304`                                          |
| Stable keys    | `FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`, `FD_AUTH_MFA_KEY`, `FD_APPROVAL_GRANT_KEY`, `FD_AUTOMATIONS_CREDENTIAL_KEY`, `FD_NOTIFICATIONS_SECRET_KEY`, `FD_WORKFLOWS_PAYLOAD_KEY`, `FD_WORKFLOWS_CURSOR_KEY`, `FD_STORAGE_ENCRYPTION_KEY`, `FD_CONNECTORS_SECRET_KEY`, `FD_AUDIT_ANCHOR_KEY` |
| Worker ticks   | `CRON_SECRET` (at least 32 characters); `FD_VERCEL_CRON_SCHEDULE` on Hobby                                                                                                                                                                                                                             |
| Public origin  | `FD_AUTH_PUBLIC_ORIGIN=https://your-domain.example`; a preview derives its deployment URL when system environment variables are exposed                                                                                                                                                                |

The artifact fixes `NODE_ENV=production`, `FD_TRUST_PROXY=true`, secure cookies
and a two-connection pool per role and Function instance. Scope preview
variables to a **separate** database, store and keys; otherwise preview code can
migrate or mutate production data.

## Limits

- A request or response body is capped at 4.5 MB, so keep
  `FD_STORAGE_MAX_OBJECT_BYTES` at or below 4194304 until uploads go directly to
  storage.
- A tick drains its workers before it answers, within the Function's 300 second
  limit. Work still running when a tick ends is stopped and recovered on a later
  tick once its lease expires.
- `/api/ready` checks the database roles. It does not prove that ticks are
  arriving; watch the Cron Jobs page and the worker Function logs.
- The embedded sandbox and workspace file edits are local development features
  and are not durable inside a Function.
