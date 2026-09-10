[![Flowdular: Build your business platform](https://cdn.jsdelivr.net/npm/create-flowdular@latest/assets/flowdular-banner.png)](https://flowdular.com)

# create-flowdular

[![npm version](https://img.shields.io/npm/v/create-flowdular?color=f59e0b)](https://www.npmjs.com/package/create-flowdular)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.22.2-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Flowdular/flowdular/blob/main/LICENSE)

Create a Flowdular application with the platform, an example module and local development configuration. Start with embedded PostgreSQL, then extend the application with your own business modules.

## Quick start

Use Node.js **22.22.2 or newer**:

```sh
npm create flowdular@latest my-app
cd my-app
```

For this new local application, initialize demo authentication and start the development server:

```sh
pnpm flowdular setup
pnpm dev
```

Open [localhost:4310](http://localhost:4310). `setup` opens an interactive wizard for a local demo, PostgreSQL settings or a configuration check. It asks before resetting the local demo database.

`npm create` launches the generator. The generated application uses **pnpm workspaces**. If pnpm is unavailable during installation, the generator invokes its pinned version through `npm exec`.

You can also launch the generator directly:

```sh
npx create-flowdular@latest my-app
```

## What you get

| Included          | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `platform/`       | Application shell and generated module composition         |
| `modules/`        | An example module and space for your business modules      |
| `flowdular.json`  | Workspace and module configuration                         |
| `.env`            | Local database selection and freshly generated secret keys |
| Workspace scripts | Development server, type checking, tests and validation    |

The generator installs dependencies and initializes Git by default. Local development uses PGlite, an embedded PostgreSQL implementation, so the default setup needs no external database server.

## Options

Pass generator flags after `--` when using `npm create`:

```sh
npm create flowdular@latest my-app -- --no-install --no-git
cd my-app
pnpm install
```

| Option                  | Behavior                                                      |
| ----------------------- | ------------------------------------------------------------- |
| `-t, --template <name>` | Select a template; defaults to `default`                      |
| `--pm pnpm`             | Select the package manager supported by this template         |
| `--no-install`          | Generate files without installing dependencies                |
| `--no-git`              | Skip Git initialization and the initial commit                |
| `-f, --force`           | Allow a nonempty target directory; inspect its contents first |
| `-h, --help`            | Show usage                                                    |
| `-v, --version`         | Show the generator version                                    |

## Configuration and secrets

Each run generates separate random 32-byte keys for agent credentials, agent grants, workflow payloads, workflow cursors and authentication MFA. They are written to the new application's `.env`. Keep that file private and provide deployment secrets through your hosting environment.

The default adapter is `FD_DATABASE_ADAPTER=pglite`. For a hosted PostgreSQL deployment, follow the [database adapter guide](https://github.com/Flowdular/flowdular/blob/main/docs/database-adapters.md) and [configuration reference](https://github.com/Flowdular/flowdular/blob/main/docs/configuration.md).

## Next steps

```sh
pnpm flowdular doctor
pnpm verify
pnpm flowdular help
```

Read the [module guide](https://github.com/Flowdular/flowdular/blob/main/docs/modules.md) to extend the application. Business modules from [Official Modules](https://github.com/Flowdular/official-modules) are installed as source through the CLI.

## Packages and support

- [@flowdular/sdk](https://www.npmjs.com/package/@flowdular/sdk): shared platform APIs, UI and core modules.
- [flowdular](https://www.npmjs.com/package/flowdular): workspace CLI.
- [Documentation](https://github.com/Flowdular/flowdular/tree/main/docs) · [Source and issues](https://github.com/Flowdular/flowdular) · [Website](https://flowdular.com)

Licensed under MIT. Repository documentation and source require repository access while the repositories are private.
