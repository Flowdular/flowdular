# Getting started

Run Flowdular on your machine, create a workspace, and sign in.

## Requirements

- Node.js 22.22.2 or newer
- pnpm 11.17.0
- No database server: the platform ships an embedded PostgreSQL and keeps it
  under `.flowdular/data`

## Install and check the workspace

```bash
pnpm install
pnpm flowdular doctor
```

`doctor` reports workspace health (configuration, enabled modules, generated
composition, guardrail files). Add `--json` for a machine-readable envelope.

## Run the platform

```bash
pnpm dev
```

On the first run, open [localhost:4310/setup](http://localhost:4310/setup).
Enter the one-time token from the terminal, then create your
workspace and owner account. Embedded PostgreSQL is already configured. Restart
`pnpm dev` after setup and sign in with that account.

Vite HMR covers TSRX, TypeScript and styles. The launcher keeps tool warnings
quiet; use `pnpm dev -- --verbose` for full diagnostics. `pnpm dev` runs
`module sync` first, so a composition change is picked up without a manual
step. The session lives in an HttpOnly cookie and carries the scopes of the
selected tenant membership. A bookmark pointing at another workspace you
belong to switches the session on load.

`Development` navigation is visible only to tenant owners; server permissions
stay authoritative either way.

## Optional local demo reset

`pnpm flowdular setup quick` resets local authentication data and seeds two
demo workspaces. It is for development or test databases only. Stop `pnpm dev`
and review the dry-run plan before applying it:

```bash
pnpm flowdular setup quick                                     # dry run, prints the plan
pnpm flowdular setup quick --apply --confirm reset-local-auth  # resets and seeds
```

The demo logins are `admin@example.com` / `Owner!23456789` (owner) and
`user@example.com` / `Member!2345678` (member).

## Where local state lives

The database and the development vault keys live under `.flowdular/data`. Every
module shares one embedded PostgreSQL in `.flowdular/data/pglite`, which
`FD_DATABASE_PGLITE_DIRECTORY` can redirect. Point `FD_DATABASE_ADAPTER` at
`postgresql` and give it `FD_DATABASE_URL` to run against a real server instead.
See [configuration.md](configuration.md).

## Migrating preserved state from `.octane-erp`

`setup migrate-state` is an isolated compatibility bridge for workspaces that
still hold state under the old directory:

```bash
pnpm flowdular setup migrate-state
# Stop the platform, the sandbox, and anything holding those files open first.
pnpm flowdular setup migrate-state --apply --confirm migrate-legacy-state
```

The dry run lists every source, destination and collision. Apply copies the
vault key files, refuses symbolic links and existing destination files, verifies
every copied file and never removes the legacy source directory. SQLite database
files are reported by name and left in place: the PostgreSQL and PGlite adapters
cannot read them, so start a fresh workspace on the current adapter; that data
does not carry over.

## Agents in a local workspace

`agents.core` ships enabled: reusable agent definitions, an isolated playground
and durable run history. Enqueue returns once the run is committed, so execution
continues across navigation, a closed browser or a sign-out. Agents reach
platform data only through tools registered against approved API endpoints or
CLI capabilities. The default local provider is a simulation: it calls no
external model and no network service, so nothing leaves your machine until you
bind a real provider under Providers.

## Landing site

The public website lives in [Flowdular/landing](https://github.com/Flowdular/landing): one
server-rendered page, no session and no module composition, so marketing work
never reaches the product. The platform serves the workspace itself at `/`.

```bash
git clone https://github.com/Flowdular/landing.git
cd landing
pnpm install
pnpm dev       # http://127.0.0.1:4330
```

## Next

- Build a module: [modules.md](modules.md)
- Build one by chat: [sandbox.md](sandbox.md)
- Every command: [cli.md](cli.md)
