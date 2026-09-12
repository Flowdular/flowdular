# Getting started

Run Flowdular on your machine, seed a demo workspace, and sign in.

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

## Seed a local demo

`pnpm flowdular setup` opens an interactive wizard. Choose a local demo, configure PostgreSQL, or check the existing configuration. Local initialization requires confirmation and a stopped application.

For scripts and CI, `setup quick` is a destructive local reset. It prints its full plan first and
writes only after a typed confirmation:

```bash
pnpm flowdular setup quick                                     # dry run, prints the plan
pnpm flowdular setup quick --apply --confirm reset-local-auth  # resets and seeds
```

Stop `pnpm dev` before applying it. Quick setup is blocked outside development
and test, and must never point at a deployed database.

It creates two demo tenants (Operations Demo, Finance Demo) and two logins:

| Account             | Password         | Role                       |
| ------------------- | ---------------- | -------------------------- |
| `admin@example.com` | `Owner!23456789` | Owner of both demo tenants |
| `user@example.com`  | `Member!2345678` | Reduced scope member       |

## Run the platform

```bash
pnpm dev
```

Open `http://localhost:4310`. Vite HMR covers TSRX, TypeScript and styles. The
launcher keeps tool warnings quiet; use `pnpm dev -- --verbose` for full
diagnostics. `pnpm dev` runs `module sync` first, so a composition change is
picked up without a manual step.

The first visit opens the `auth.core` sign-in flow. The session lives in an
HttpOnly cookie and carries the scopes of the selected tenant membership. On a
clean database the sign-up wizard is available: workspace name plus a unique
workspace id (the first URL segment, `/{workspace}/{view}`), then the
administrator account, then an optional email confirmation step. A bookmark
pointing at another workspace you belong to switches the session on load.

`Development` navigation is visible only to tenant owners; server permissions
stay authoritative either way.

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
