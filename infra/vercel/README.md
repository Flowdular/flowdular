# Vercel deployment

One command provisions the database, storage and keys, deploys to Vercel
Production and prints a one-time token; the first workspace is then created in
the browser.

## Hobby or Pro

|                                                                                                                                 | Hobby                                   | Pro                   |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------- |
| Work a request queues (agent runs, renders, notifications, imports, exports)                                                    | starts within seconds                   | starts within seconds |
| Time-driven work (scheduled automations, retries and recovery after a lost lease, approval expiries, retention sweeps, digests) | next request or the daily 03:00 UTC run | within about a minute |
| Longest agent run                                                                                                               | about 4 minutes                         | about 12 minutes      |
| Allowed use                                                                                                                     | personal, non-commercial                | commercial            |

On Hobby, an external scheduler can tick the worker every minute instead: have
it call `GET https://<domain>/api/internal/worker/tick` with the header
`Authorization: Bearer <CRON_SECRET>`. The secret then also lives at that third
party.

## Prerequisites

1. Node.js 24 and pnpm 11, then `pnpm install` in this repository.
2. A Vercel account. The repository does not need to be pushed: the command
   uploads this directory.
3. The Vercel CLI 62 or newer (verified with 62.2.0): `npm i -g vercel`.
4. `vercel login`.

## Deploy with one command

1. `pnpm flowdular deploy plan vercel` checks the Vercel CLI and `.vercelignore`
   and lists every step. It changes nothing.
2. `pnpm flowdular deploy start vercel --apply` runs those steps. Answer the
   Vercel prompts it shows while linking the project and adding Neon.

Flags that matter:

- `--project <name>` names the Vercel project to create or link.
- `--scope <team>` picks the team when the account has several.
- `--plan hobby|pro` sets the plan. Without it the command reads the team's plan
  from `vercel whoami --json` (Enterprise counts as Pro). When that gives no
  answer it sizes for Pro, and if Vercel then rejects the per-minute cron it
  switches to Hobby and deploys once more.
- `--origin https://erp.example.com` when production is served from your own
  domain instead of `<project>.vercel.app`.
- `--database-url-env NAME` uses an existing PostgreSQL instead of Neon. Run
  `read -rs FD_OWNER_URL && export FD_OWNER_URL`, paste the owner URL (it stays
  out of shell history), then pass `--database-url-env FD_OWNER_URL`. A URL is
  never accepted on the command line.
- `--cron "<expression>"` overrides the worker schedule the plan sets.

A rerun resumes after any failure and never regenerates a key that the backup or
Vercel already holds. If the Vercel CLI fails after it created the deployment,
for example with `Error: fetch failed` while streaming build logs, the command
follows that deployment on Vercel for up to 15 minutes and carries on once it
is Ready.

## What it prints and what to back up

1. Progress lines and the Vercel build output, with every secret value replaced
   by `[redacted]`.
2. A summary: the URL, the key backup path, the plan, the worker schedule, the
   setup address, the setup token and the file that holds it.
3. Copy `.flowdular/deploy/vercel-<project id>.env` (mode 0600) to a password
   manager or encrypted storage off this machine. Vercel cannot show a sensitive
   value again, so this file is the only readable copy of the keys.
4. Until the first workspace exists, the setup token is kept in
   `.flowdular/deploy/vercel-<project id>.setup-token` (mode 0600), written
   before its SHA-256 is uploaded as `FD_SETUP_TOKEN_SHA256`. The command names
   that file before it deploys and in every failure, so a failed run never loses
   the token. A rerun before setup reuses it; the first run after setup deletes
   the file and removes `FD_SETUP_TOKEN_SHA256` from Vercel.

## Create the first workspace

1. Open the printed address, `https://<domain>/setup`, and paste the setup token.
2. Enter the workspace name and address, then your name, email and password.
   The database step is skipped because the deployment provides it.
3. Review and choose **Migrate and create workspace**.
4. Choose **Go to sign in** and sign in. The app serves normally from the next
   request, with no redeploy.
5. Optional: connect an AI model key under Providers.

## Check that it works

1. `curl -s https://<domain>/api/ready` answers HTTP 200 with
   `"status":"ready"`.
2. The project's Cron Jobs settings page lists `/api/internal/worker/tick` with
   `* * * * *` on Pro or `0 3 * * *` on Hobby.
3. The project's Logs, filtered to `/api/internal/worker/tick`, show a tick
   after each cron run and after each state-changing request.
4. In the agents playground, queue a run and watch it finish. The worker badge
   there reads "worker offline" on Vercel, because it reports the web Function,
   which never runs workers; the run finishing is the check.

## Move from Hobby to Pro

1. Upgrade the team in the Vercel dashboard.
2. `pnpm flowdular deploy start vercel --apply` reads Pro, sets
   `FD_VERCEL_PLAN=pro` and redeploys. Pass `--plan pro` if it cannot read the
   plan.
3. If you set `FD_VERCEL_CRON_SCHEDULE` yourself, remove it with
   `vercel env rm FD_VERCEL_CRON_SCHEDULE production --yes` and run step 2
   again.

## Redeploy after a code change

1. `pnpm flowdular deploy start vercel --apply` deploys the working directory
   and reuses everything else, or `vercel deploy --prod` deploys the code alone.
2. A project connected to Git also deploys on every push to its production
   branch.

## Rotate CRON_SECRET

1. Delete the `CRON_SECRET=` line from the key backup file.
2. `vercel env rm CRON_SECRET production --yes`
3. `pnpm flowdular deploy start vercel --apply` generates a new secret into the
   backup, uploads it and redeploys. Vercel Cron uses it from that deployment.
4. Give the new value to any external scheduler.

## Manual path

1. `vercel link` at the repository root, or import the project from the URL
   `pnpm flowdular deploy plan vercel` prints. Select Node.js 24.
2. Provision PostgreSQL and use the direct host, not a PgBouncer pooler: the
   platform sends statement and lock timeouts as startup parameters, which a
   pooler refuses.
3. As the database owner, create `flowdular_runtime` and `flowdular_background`
   without `SUPERUSER` or `BYPASSRLS` and grant what
   `infra/docker/postgres/10-roles.sh` grants. The owner role is the migrator.
4. Generate each stable key with `openssl rand -base64 32`, except
   `FD_AUTH_MFA_KEY`: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
   Keep them in a 0600 file off the machine.
5. Generate `CRON_SECRET` with `openssl rand -hex 32`.
6. Add every Production variable below through stdin, for example
   `printf '%s' "$VALUE" | vercel env add NAME production --sensitive`:
   - `FD_DATABASE_ADAPTER=postgresql`
   - `FD_DATABASE_URL` (runtime role), `FD_DATABASE_BACKGROUND_URL` (background
     role), `FD_DATABASE_MIGRATOR_URL` (owner)
   - `FD_DATABASE_TLS=verify-full`, plus `FD_DATABASE_TLS_CA` or
     `FD_DATABASE_TLS_CA_FILE` when the server certificate is not publicly
     trusted
   - `FD_STORAGE_ADAPTER=vercel-blob` and `FD_STORAGE_MAX_OBJECT_BYTES=4194304`,
     or `FD_STORAGE_ADAPTER=s3` with `FD_STORAGE_S3_BUCKET`,
     `FD_STORAGE_S3_REGION`, `FD_STORAGE_S3_ACCESS_KEY_ID` and
     `FD_STORAGE_S3_SECRET_ACCESS_KEY`
   - `FD_AGENT_CREDENTIAL_KEY`, `FD_AGENT_RUN_GRANT_KEY`, `FD_AUTH_MFA_KEY`,
     `FD_APPROVAL_GRANT_KEY`, `FD_AUTOMATIONS_CREDENTIAL_KEY`,
     `FD_NOTIFICATIONS_SECRET_KEY`, `FD_WORKFLOWS_PAYLOAD_KEY`,
     `FD_WORKFLOWS_CURSOR_KEY`, `FD_STORAGE_ENCRYPTION_KEY`,
     `FD_CONNECTORS_SECRET_KEY`, `FD_AUDIT_ANCHOR_KEY`
   - `CRON_SECRET`
   - `FD_AUTH_PUBLIC_ORIGIN=https://<domain>`
   - `FD_VERCEL_PLAN=hobby` or `pro`; optionally `FD_VERCEL_CRON_SCHEDULE` and
     `FD_WORKER_TICK_WINDOW_MS`
7. For Blob storage, `vercel storage create <name> --type blob --access private`,
   then `vercel storage connect <store id> --environment production --yes`.
8. Make a setup token and store only its hash:
   `TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')`, then
   `printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1 | tr -d '\n' | vercel env add FD_SETUP_TOKEN_SHA256 production --sensitive`.
9. `vercel deploy --prod`.
10. Open `https://<domain>/setup` and enter `$TOKEN`.

Scope preview variables to a separate database, store, keys and setup token;
otherwise preview code can migrate or mutate production data.

## Tear down

1. Delete the Neon database and every row in it with
   `vercel integration resource remove <resource> --disconnect-all --yes`; the
   resource name is on the project's Storage tab.
2. `vercel storage delete <project>-files --type blob` deletes the Blob store
   after a confirmation.
3. `vercel project rm <project>`.
4. Remove `.vercel`, and destroy every copy of the key backup once the data is
   gone.

## Troubleshooting

- **"Hobby accounts are limited to daily cron jobs"**: the team is on Hobby and
  the build asked for a tighter cron. Rerun with `--plan hobby`, or remove a
  tighter `FD_VERCEL_CRON_SCHEDULE`.
- **`/api/ready` answers 503**: the database or its role check failed. Check the
  web Function logs, the three database URLs and that the Neon compute is up. A
  500 on every path means boot failed, and the log line `platform boot failed`
  names the cause, such as a missing `FD_SETUP_TOKEN_SHA256` while no workspace
  exists.
- **The setup page refuses the token**: use the token in
  `.flowdular/deploy/vercel-<project id>.setup-token`, which every run before
  setup reuses. If that file was deleted, the next run made a new token and only
  that one works. Five wrong tries lock that instance for five minutes. If the page asks for the token again after a step, the request
  reached another Function instance, which holds its own setup session; enter the
  token again and repeat that step.
- **`Failed to connect <owner>/<repo> to project` while linking**: harmless. The
  command uploads this directory, so the deployment does not need Git; pushes
  just do not deploy on their own. Connect the repository later in the
  project's Settings, Git.
- **Scheduled automations do not fire on Hobby**: between requests they wait
  for the next request or the daily run. Move to Pro or add an external
  scheduler (see [Hobby or Pro](#hobby-or-pro)).
- **An agent run started over**: it outlived its tick, about 4 minutes on Hobby
  or 12 on Pro, so Vercel stopped the Function and a later tick resumed the run
  once its lease expired. Keep runs shorter or move to Pro.

## How it runs

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

- Vercel Cron calls the tick path with a 50 second window
  (`FD_WORKER_TICK_WINDOW_MS`): every minute on Pro, once a day on Hobby.
  Scheduled work and recovery of interrupted jobs run there.
- After a state-changing `/api` request answers with a success status, the web
  Function asks for a 15 second tick, so work a member just queued starts within
  seconds instead of waiting for the next cron run. Repeated requests on one
  instance ask at most once every 5 seconds, and a tick arriving while a window
  is open joins it.

Both callers present `CRON_SECRET` as a bearer token; the worker Function reads
it as `FD_WORKER_TICK_SECRET`. Without a secret of at least 32 characters the
worker Function refuses to boot.

`FD_VERCEL_PLAN` sizes the build: the cron schedule, the worker Function's
`maxDuration` (300 seconds on Hobby, 800 on Pro) and how long a tick waits for
agent runs to finish (180 and 690 seconds). Until a workspace exists, the
application answers only `/setup`, `/api/health`, `/api/ready` and the tick
path, and each instance opens to everything on its next request after setup
finishes.

Cron runs only on the production deployment. A preview deployment ticks only
from its own requests, and only when Deployment Protection lets the request
through: enable Protection Bypass for Automation so the web Function can send
`VERCEL_AUTOMATION_BYPASS_SECRET`.

## Limits

- A request or response body is capped at 4.5 MB, so keep
  `FD_STORAGE_MAX_OBJECT_BYTES` at or below 4194304 until uploads go directly to
  storage.
- A tick drains its workers before it answers, within the worker Function's
  `maxDuration`. An agent run claimed during the window keeps running for the
  rest of the window and then up to 180 seconds on Hobby or 690 on Pro
  (`FD_AGENT_WORKER_DRAIN_MS`). Work still running after that is stopped and
  starts again from its input on a later tick once its lease expires, so a run
  claimed at the end of a window is sure to finish only within 3 minutes on
  Hobby and 11.5 on Pro.
- `/api/ready` checks the database roles. It does not prove that ticks are
  arriving; watch the Cron Jobs page and the worker Function logs.
- The embedded sandbox and workspace file edits are local development features
  and are not durable inside a Function.
