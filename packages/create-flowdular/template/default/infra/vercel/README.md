# Experimental Vercel web artifact

Flowdular's HTTP application can run as one Vercel Node.js Function. The
`vercel.json` build command first builds Octane, then writes a Build Output API
artifact: the server under `functions/flowdular.func` and public client assets
under `static`. The server's HTML and API routes stay behind Octane's
authentication. The Vercel Function is not the durable background worker.
The current composition starts background pollers inside every web Function
instance, including instances that Vercel later suspends. Registry initialization
and worker startup must be separated in the modules before this target is ready
for production traffic. `deploy start vercel --apply` remains unavailable.

## Before importing the repository

1. Provision an external PostgreSQL database with separate runtime, background
   and migrator roles. Runtime and background must have neither `SUPERUSER` nor
   `BYPASSRLS`. Require verified TLS and use a connection pooler suitable for
   many short-lived Vercel instances.
2. Provision an S3-compatible bucket. Generate and back up the stable 32-byte
   platform keys listed in the repository's production `.env.example` or
   `render.yaml`. The same keys, bucket and database must reach the web and
   worker deployments. Changing a key against existing rows makes data
   unreadable.
3. Run the first-run setup against that database from a temporary persistent
   local or container instance. Finish workspace and owner creation before the
   Vercel deployment. The Vercel Function refuses an empty or unconfigured
   database because its filesystem cannot persist the setup token or `.env`.
4. For an isolated evaluation, deploy a paid, always-on container from the same
   commit as a background worker. The existing `infra/docker/Dockerfile` starts
   the module workers; configure it as a private worker service with no public
   ingress. Give it the background, runtime and migrator database URLs, S3
   settings and the same keys. Set `FD_AUTH_PUBLIC_ORIGIN` to the Vercel HTTPS
   origin. Do not scale it to zero. Check its job logs after rollout.
   `GET /api/ready` checks database access, not active workers. Keep its
   revision aligned with the Vercel deployment.

## Vercel configuration

Run `pnpm flowdular deploy plan vercel` first. For an isolated evaluation, the
plan's URL creates a new Vercel project by cloning the pushed branch. To connect
an existing Vercel project, use `vercel link` and `vercel deploy` instead. Keep
the project root at the repository root and select Node.js 24. `vercel.json`
sets the build command. The output is also inspectable locally with
`node infra/vercel/build.mjs --package-only` after `pnpm build`.

Set these environment variables in Vercel for each environment you deploy:

| Group          | Variables                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database       | `FD_DATABASE_ADAPTER=postgresql`, `FD_DATABASE_URL`, `FD_DATABASE_BACKGROUND_URL`, `FD_DATABASE_MIGRATOR_URL`, `FD_DATABASE_TLS=verify-full`, `FD_DATABASE_TLS_CA` or `FD_DATABASE_TLS_CA_FILE`                                                                                                        |
| Object storage | `FD_STORAGE_ADAPTER=s3`, `FD_STORAGE_S3_BUCKET`, `FD_STORAGE_S3_REGION`, `FD_STORAGE_S3_ACCESS_KEY_ID`, `FD_STORAGE_S3_SECRET_ACCESS_KEY`; add `FD_STORAGE_S3_ENDPOINT` and `FD_STORAGE_S3_FORCE_PATH_STYLE` for a compatible store                                                                    |
| Stable keys    | `FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`, `FD_AUTH_MFA_KEY`, `FD_APPROVAL_GRANT_KEY`, `FD_AUTOMATIONS_CREDENTIAL_KEY`, `FD_NOTIFICATIONS_SECRET_KEY`, `FD_WORKFLOWS_PAYLOAD_KEY`, `FD_WORKFLOWS_CURSOR_KEY`, `FD_STORAGE_ENCRYPTION_KEY`, `FD_CONNECTORS_SECRET_KEY`, `FD_AUDIT_ANCHOR_KEY` |
| Public origin  | `FD_AUTH_PUBLIC_ORIGIN=https://your-domain.example`; a Vercel preview may derive its deployment URL if system environment variables are exposed                                                                                                                                                        |

The build artifact fixes `NODE_ENV=production`, `FD_TRUST_PROXY=true`, secure
cookies and a two-connection pool per role and Function instance. The database
provider still needs a pooler and capacity for concurrent instances. Scope
preview environment variables to a **separate** database, bucket and keys;
otherwise preview code can migrate or mutate production data. Vercel serves
`/api/health` and `/api/ready` from the web Function. `ready` checks database
roles, not whether the companion worker is alive, so monitor the worker too.

## Limits and follow-up

The Vercel Function may stop when no request is in flight. Module jobs remain
in PostgreSQL and the companion worker owns recovery. Today the Function also
starts module pollers while warm. Database leases and idempotency limit
contention, but a Function may be stopped before its background work drains.
The production fix is a composition contract that initializes HTTP registries
without starting those pollers.
Vercel caps Function request and response bodies at 4.5 MB, so larger document
transfers need a direct-to-storage route before they can use this target. The
embedded sandbox and workspace file edits are local development features and
are not durable inside a Function.

A Vercel-only worker would require a public, bounded `tick/drain` composition
contract for every module's background loop, including workflows and agent
execution. A Pro cron or Queue consumer could then call it, recover work from
PostgreSQL and drain before the Function deadline. Today `start()` mixes worker
timers with registry sealing, and a warm Function cannot restart a retired
composition safely, so a cron that merely sleeps beside those timers would
not provide recovery.

## Work required for production launch

There are 16 module `start()` hooks in the current composition:

| Hook group                       | Modules                                                                                       | Required split                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry setup only              | `access.core`, `users.core`, `research.core`, `reports.core`, `search.core`, `metering.core`  | Keep registration and sealing in web startup.                                                                                                                                                   |
| Registry setup plus worker loops | `adapters.core`, `audit.core`, `documents.core`, `exports.core`, `import.core`, `agents.core` | Keep catalogue and port sealing available to HTTP; start and drain pollers only in the worker. `agents.core` also reconciles module agents at startup and needs a defined owner for that write. |
| Worker loops only                | `approvals.core`, `automations.core`, `notifications.core`, `workflows.core`                  | Start on the companion worker only; make web requests persist work before acknowledging it.                                                                                                     |

The follow-up change needs an optional `startWorker()` composition hook, with
`start()` limited to registry and HTTP setup after all modules compose. A
default `combined` runtime role would call both, while a Vercel `web` role
would skip `startWorker()` and demonstrably leave no timer or background lease
running. Worker start must be awaited and `stop()` must drain before disposal,
including after partial startup. Each affected module needs spec approval.
`createJobRunner.wake()` runs a pass even before `start()`: `adapters.core` and
`documents.core` call it after enqueue from HTTP. Their web callbacks must
persist the job without claiming it in the Function, then let the companion
poll. `automations.core` re-times schedules from an in-process settings change
listener; that change must reach the worker through durable state too.
A PostgreSQL heartbeat keyed by deployment and instance should record the exact
revision and expiry after the worker starts;
the web rollout gate must verify that revision, not merely `/api/ready`.
Migrations should run before routing traffic, with the web Function reduced to
runtime credentials once the database provider supports verify-only startup.
Then test a real Vercel deployment with an external database and bucket:
first-run already complete, HTTP and authentication, migrations, duplicate
requests, cold starts, worker restart and lease recovery. Only then can the
CLI enable a deploy command that reports the whole platform as ready.
