# Flowdular app

Created with `npx create-flowdular@latest`. This is the Flowdular platform, one
example module, and nothing else you have to configure.

## Run it

```bash
pnpm install
pnpm dev
```

On the first run, the server starts the setup page and `pnpm dev` opens it in
your browser. Enter the one-time token printed in the terminal, then choose
your workspace and owner account. The embedded database is already selected.
If a browser cannot open automatically, visit <http://localhost:4310/setup>.
Restart `pnpm dev` after setup, then sign in with the account you chose. Use
`pnpm dev -- --no-open` to leave the browser alone.

Local development runs on embedded PostgreSQL, so there is no database server to
install. Data lives under `.flowdular/data`.

## What is here

| Path              | Contents                                                     |
| ----------------- | ------------------------------------------------------------ |
| `platform`        | The deployable composition root and the application shell    |
| `modules/example` | A tenant-scoped record module: API, migration, screen, tests |
| `specs`           | The platform spec of this application                        |
| `infra`           | Docker, Kubernetes and Vercel deployment assets              |
| `flowdular.json`  | Enabled modules and locales, owned by the CLI                |
| `.env`            | The keys generated for this app. Never commit it             |
| `.env.example`    | Every key a production deployment reads                      |

## Work with coding agents

`AGENTS.md` and `CLAUDE.md` introduce the application contract. `.ai` contains the
editable rules, skills, role prompts, subagents, policies, blueprints and
reference module. Codex and Claude Code discover generated skills in
`.agents/skills` and `.claude/skills`, and the spec author, module executor and
reviewer as subagents in `.codex/agents` and `.claude/agents`. Supporting guides
are in `docs`.

After editing `.ai/rules`, `.ai/skills` or `.ai/subagents`, run `pnpm rules:generate`.
`pnpm rules:check` detects drift and also runs as part of `pnpm verify`.
Extend local modules using the published `@flowdular/sdk` imports. Installed
SDK source is reference material and must not be edited in `node_modules`.

## Build your first module

```bash
pnpm flowdular module new sales.orders --spec modules/sales-orders/spec/module.yaml
pnpm flowdular module new sales.orders --spec modules/sales-orders/spec/module.yaml --apply
pnpm flowdular module enable sales.orders --apply
```

A module is created only from a spec with `status: approved`. Copy
`modules/example` for the shape: an approved spec, one permission per action,
tenant-scoped SQL with forced row-level security, translations per locale, and
tests.

`platform/src/generated/**`, `platform/package.json` dependencies and
`modules.enabled` in `flowdular.json` are written by the CLI. Never edit them by
hand.

## Build a module by chat

```bash
pnpm sandbox
```

The sandbox is a chat-first builder on `http://127.0.0.1:4320`. You describe the
change, it writes the module in an isolated workspace, runs the same gates this
repository runs, and previews the result inside the real application shell.
`--port`, `--workspace`, `--host` and `--mode` override the defaults.

It is a client of a running application and never opens its database. Connect it
once: in the app open Administration, API tokens, issue a token with
`sandbox.access.use` plus the read scopes the preview should see, grant the
account access, then paste the token and the application address into the
connect screen.

```bash
pnpm flowdular sandbox grant --email <your-owner-email> --tenant <your-workspace-slug> --apply
```

## Deploy

```bash
node infra/docker/start.mjs
```

The launcher creates `infra/docker/.env` with private database passwords and
keys, starts PostgreSQL and MinIO, then opens the setup page. Enter the token
shown in the terminal. The database step is already complete, so you start with
the workspace owner. `infra/README.md` covers the stack and deployments.

To deploy on Vercel, run `pnpm flowdular deploy plan vercel` and follow
`infra/vercel/README.md`. It needs an external PostgreSQL database and object
storage; module workers run in a worker Function that Vercel Cron and
state-changing requests tick.

## Commands

```bash
pnpm dev              # platform with HMR on http://localhost:4310
pnpm sandbox          # chat-first module builder on http://127.0.0.1:4320
pnpm verify           # typecheck, tests, spec and module validation, format
pnpm flowdular doctor  # workspace health
```

Every write command is a dry run without `--apply`; destructive ones also need
`--confirm`.
