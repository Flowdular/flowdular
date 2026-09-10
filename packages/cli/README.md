[![Flowdular: Build your business platform](https://cdn.jsdelivr.net/npm/flowdular@latest/assets/flowdular-banner.png)](https://flowdular.com)

# Flowdular CLI

[![npm version](https://img.shields.io/npm/v/flowdular?color=f59e0b)](https://www.npmjs.com/package/flowdular)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.22.2-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Flowdular/flowdular/blob/main/LICENSE)

Inspect, configure and extend a Flowdular application from your terminal. The CLI manages module validation, source installation, generated composition and workspace diagnostics.

## Quick start

Use Node.js **22.22.2 or newer**. Create a configured pnpm workspace:

```sh
npm create flowdular@latest my-app
cd my-app
pnpm flowdular doctor
pnpm flowdular help
```

The generator includes the CLI. To add it to an existing Flowdular workspace:

```sh
pnpm add -Dw flowdular
```

The executable is `flowdular`; `fd` is also available as an alias. Run commands from your application workspace.

## Everyday commands

| Command                                   | Purpose                                         |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm flowdular doctor`                   | Inspect workspace configuration and diagnostics |
| `pnpm flowdular help`                     | List commands and supported flags               |
| `pnpm flowdular module search`            | Browse the configured source catalog            |
| `pnpm flowdular module install <id>`      | Preview a source installation                   |
| `pnpm flowdular module sync --apply`      | Regenerate application composition              |
| `pnpm flowdular module validate --locked` | Validate modules against the installation lock  |

## Install a business module

For a catalog containing `expenses.core`:

```sh
# Inspect the planned source installation.
pnpm flowdular module install expenses.core

# Download and unpack the module source.
pnpm flowdular module install expenses.core --apply

# Enable the module and grant its scopes in the configured application.
pnpm flowdular module enable expenses.core --apply

# Check the installed modules against their lock.
pnpm flowdular module validate --locked
```

Source installation previews by default. Applying it writes source under `modules/`; activation is a separate step. Enabling a module updates application composition and can grant scopes against the configured database.

[Official Modules](https://github.com/Flowdular/official-modules) requires repository access while private. For an accessible local catalog, pass `--registry /absolute/path/to/index.json` to the search or install command. Catalog availability is independent of npm package installation.

## Automation

Release tooling can import the source distribution API through `flowdular/distribution`. Command permissions and apply requirements are documented in the [CLI guide](https://github.com/Flowdular/flowdular/blob/main/docs/cli.md).

## Packages and support

- [@flowdular/sdk](https://www.npmjs.com/package/@flowdular/sdk): shared platform APIs, UI and core modules.
- [create-flowdular](https://www.npmjs.com/package/create-flowdular): application generator.
- [Documentation](https://github.com/Flowdular/flowdular/tree/main/docs) · [Source and issues](https://github.com/Flowdular/flowdular) · [Website](https://flowdular.com)

Licensed under MIT. Repository documentation and source require repository access while the repositories are private.

## Interactive setup

Run `pnpm flowdular setup` in a terminal. The wizard offers a local demo, existing
PostgreSQL connection settings, or a configuration check. Local resets require
confirmation and a stopped application; custom or hosted databases are refused.
PostgreSQL URLs are masked and saved to `.env` with TLS verification; this does
not initialize, reset or connect to the hosted database.

Without an interactive terminal, `setup` remains a configuration check. Use
`setup check --json` for machine-readable results and
`setup quick --apply --confirm reset-local-auth` for an explicitly authorized
local reset in a script. Ctrl+C or declining confirmation leaves data unchanged.
