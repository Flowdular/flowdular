[![Flowdular: Build your business platform](https://cdn.jsdelivr.net/npm/@flowdular/sdk@latest/assets/flowdular-banner.png)](https://flowdular.com)

# Flowdular SDK

[![npm version](https://img.shields.io/npm/v/@flowdular/sdk?color=f59e0b)](https://www.npmjs.com/package/@flowdular/sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.22.2-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Flowdular/flowdular/blob/main/LICENSE)

The shared foundation for Flowdular applications: server APIs, client integration, UI components, databases, agents and bundled core modules. Build business modules against one SDK with explicit imports for each part of the platform.

## Start a new application

Use Node.js **22.22.2 or newer**. The generated workspace uses pnpm.

```sh
npm create flowdular@latest my-app
cd my-app
pnpm flowdular doctor
```

The generator configures the SDK and the Flowdular/Octane build toolchain. To add the SDK to an existing compatible workspace, install it in the package that imports it:

```sh
pnpm add @flowdular/sdk
```

## Import what you need

```ts
// Server-side module code
import { defineEndpoint } from '@flowdular/sdk/server';
import type { ModuleManifest } from '@flowdular/sdk/contracts';
```

```ts
// Client-side module code
import { Button } from '@flowdular/sdk/ui';
import '@flowdular/sdk/ui/styles';
```

The SDK ships TypeScript and TSRX source for the Flowdular/Octane toolchain. It has no root import. Keep server and database imports in server code; use client and UI entrypoints in browser code.

## What's included

| Area                                    | Import paths                                                     |
| --------------------------------------- | ---------------------------------------------------------------- |
| Module contracts and runtime            | `@flowdular/sdk/contracts`, `@flowdular/sdk/kernel`              |
| HTTP endpoints                          | `@flowdular/sdk/server`                                          |
| Client integration and translations     | `@flowdular/sdk/client`, `@flowdular/sdk/client/i18n`            |
| Shared UI and styles                    | `@flowdular/sdk/ui`, `@flowdular/sdk/ui/styles`                  |
| Database contracts and local PostgreSQL | `@flowdular/sdk/database`, `@flowdular/sdk/database-pglite`      |
| Database test helpers                   | `@flowdular/sdk/database-testing`                                |
| Agents and providers                    | `@flowdular/sdk/harness`, `@flowdular/sdk/ai-provider`           |
| Development APIs                        | `@flowdular/sdk/dev-console`, `@flowdular/sdk/cli-protocol`      |
| Bundled core modules                    | `@flowdular/sdk/modules/<name>`, including `modules/auth/server` |

Business modules are distributed as source archives through [Official Modules](https://github.com/Flowdular/official-modules). Installing an archive and enabling a module are separate CLI actions.

The coding sandbox is a separate application distributed as `@flowdular/sandbox`.
Launch it with `npx @flowdular/sandbox` from your application directory. It depends
on the SDK; installing the SDK alone does not install the sandbox application or
its launcher. The SDK's `modules/sandbox` export is the platform access/grant
module, not the coding application.

## Build a module

Use explicit permissions for endpoints, tenant-bound database access and the shared UI components. Run the generated workspace's checks before delivery:

```sh
pnpm verify
```

See the [module guide](https://github.com/Flowdular/flowdular/blob/main/docs/modules.md), [database adapters](https://github.com/Flowdular/flowdular/blob/main/docs/database-adapters.md) and [design system](https://github.com/Flowdular/flowdular/blob/main/docs/design-system.md).

## Packages and support

- [flowdular](https://www.npmjs.com/package/flowdular): workspace CLI.
- [create-flowdular](https://www.npmjs.com/package/create-flowdular): application generator.
- [Documentation](https://github.com/Flowdular/flowdular/tree/main/docs) · [Source and issues](https://github.com/Flowdular/flowdular) · [Website](https://flowdular.com)

Licensed under MIT. Repository documentation and source require repository access while the repositories are private.
