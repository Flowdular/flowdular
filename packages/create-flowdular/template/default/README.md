# Flowdular app

Created with `npx create-flowdular@latest`. This is the Flowdular platform, one
example module, and nothing else you have to configure.

## Run it

```bash
pnpm install
pnpm flowdular setup quick --apply --confirm reset-local-auth
pnpm dev
```

Open <http://localhost:4310> and sign in as `admin@example.com`. Quick setup is
a destructive local reset: stop `pnpm dev` first, and never point it at a
deployed database.

Local development runs on embedded PostgreSQL, so there is no database server to
install. Data lives under `.flowdular/data`.

## What is here

| Path              | Contents                                                     |
| ----------------- | ------------------------------------------------------------ |
| `platform`        | The deployable composition root and the application shell    |
| `modules/example` | A tenant-scoped record module: API, migration, screen, tests |
| `flowdular.json`  | Enabled modules and locales, owned by the CLI                |
| `.env`            | The keys generated for this app. Never commit it             |

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

## Commands

```bash
pnpm dev              # platform with HMR on http://localhost:4310
pnpm verify           # typecheck, tests, module validation, format
pnpm flowdular doctor  # workspace health
```

Every write command is a dry run without `--apply`; destructive ones also need
`--confirm`.
