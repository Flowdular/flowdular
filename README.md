<div align="center">

<img src="docs/assets/flowdular-readme-hero.webp" alt="Flowdular connects business modules, people, agents and workflows in one platform." width="100%" />

### Build the software your business runs on.

Flowdular is an open-source platform for business applications. It provides the shared foundation for workspaces, identity, permissions, data, agents and workflows. Your team adds the modules that fit its work, then owns the source code and deployment.

[![CI](https://github.com/flowdular/flowdular/actions/workflows/ci.yml/badge.svg)](https://github.com/flowdular/flowdular/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/create-flowdular?label=create-flowdular&color=2557D6)](https://www.npmjs.com/package/create-flowdular)
[![sandbox](https://img.shields.io/npm/v/%40flowdular%2Fsandbox?label=sandbox&color=2557D6)](https://www.npmjs.com/package/@flowdular/sandbox)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2022.22.2-3A6BE0)
![Status](https://img.shields.io/badge/status-preview-8290A8)
[![License](https://img.shields.io/badge/license-MIT-2557D6)](LICENSE)

[Website](https://flowdular.com) · [Platform](#the-platform) · [Sandbox](#build-with-the-sandbox) · [Quick start](#quick-start) · [Deployment](#deploy-for-your-business) · [Documentation](docs/README.md)

</div>

## The platform

A Flowdular application combines an application shell with modules that own their screens, APIs, data, permissions and tests. The platform handles the common work around them:

- **People and access:** accounts, workspaces, roles, scopes, API tokens and tenant isolation.
- **Work and automation:** records, documents, agents, versioned workflows, schedules and human approvals.
- **Delivery and operations:** module composition, validation gates, audit history, health checks and deployment assets.

Build an internal operations system, a customer portal or a vertical product on the same foundation. Industry rules and screens live in your own modules, where your team can inspect and change them. [Explore the platform capabilities](.ai/platform-capabilities.md) and [module contract](docs/modules.md).

> **Preview release.** Flowdular is under active development. APIs and module contracts can change; evaluate it against your requirements before adopting it for business-critical work.

### See it in use

This short walkthrough uses actual platform screens and synthetic sample data. Real AI calls require a configured model provider.

<img src="docs/assets/demo/flowdular-product-tour.gif" alt="A tour of the Flowdular workspace, workflows and agents." width="100%" />

[Full-size MP4](docs/assets/demo/flowdular-product-tour.mp4) · [Full dashboard](docs/assets/demo/flowdular-workspace-full.webp) · [Demo details](docs/assets/demo/README.md)

| Shared workspace                                                                                                                | Workflows with visible steps                                                                                                            |
| :------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/assets/demo/flowdular-workspace.webp" alt="Flowdular workspace with navigation and a dashboard." width="100%" /> | <img src="docs/assets/demo/flowdular-workflows.webp" alt="Draft workflow with connected input, agent and output steps." width="100%" /> |
| Keep the team's modules and daily work in one place.                                                                            | Design a workflow with visible steps and pinned agent revisions.                                                                        |

### Building blocks

| Area                    | What an application can use                                                                                  |
| :---------------------- | :----------------------------------------------------------------------------------------------------------- |
| Identity and governance | Workspaces, roles and scopes, API tokens, tenant-scoped PostgreSQL, audit history and retention.             |
| Business work           | Shared UI, English and Polish translations, search, reports, CSV import, exports and documents.              |
| Agents and workflows    | Provider connections, registered tools, durable runs, budgets, versioned workflows, schedules and approvals. |
| Integrations            | Connectors with sealed credentials, consent and call history, plus notifications, mail and storage ports.    |

Capabilities are enabled and configured per application. Model providers and external services need their own credentials and setup.

## What can you build?

These are examples of applications to build on Flowdular. Their industry-specific rules and screens belong in your own modules.

| Your team               | An application you could build                      | Foundation you can reuse                                          |
| :---------------------- | :-------------------------------------------------- | :---------------------------------------------------------------- |
| Operations              | Purchasing, order tracking or an internal ERP       | Workspaces, roles, records, documents, imports and exports        |
| Product company         | A vertical SaaS product or customer portal          | Tenant isolation, module screens, public web pages and API tokens |
| Finance and procurement | Expense review or supplier qualification            | Approval requests, audit history, workflows and connectors        |
| Research and case teams | Gather evidence, review a case and produce a report | Web research, document text, agents and PDF/DOCX templates        |

Module Studio connects an application to a catalog, a pinned Git repository or local releases. It shows an exact change plan before installation, and Sandbox helps build your own module from an approved specification. See [module distribution](docs/module-distribution.md).

## From a request to a working module

```text
Describe the work → Approve the spec → Build → Preview → Review → Deliver
```

1. **Describe the business need.** Define the records, screens, actions and permissions. Record the decisions and what is out of scope in `spec/module.yaml`.
2. **Approve the specification.** In the sandbox, implementation is tied to the exact approved spec hash. An agent cannot approve its own work.
3. **Build and preview.** The sandbox's specialists, or a developer in their own tools, implement the module against shared contracts and the design system. The sandbox previews it inside the application shell with an isolated database.
4. **Review and deliver.** Run validation, types, tests, formatting and automated review. Eject the change into your workspace or deliver a branch and pull request with the gate results.

The result is a module your team can read, test, change and version. [Module guide](docs/modules.md) · [Sandbox guide](docs/sandbox.md) · [Reference module](.ai/references/catalog)

## Quick start

Use Node.js **22.22.2 or newer** and **pnpm 11**. The generator installs dependencies and configures an embedded PostgreSQL database for local development.

```bash
npm create flowdular@latest my-app
cd my-app
pnpm dev
```

The browser opens the first-run setup at [localhost:4310/setup](http://localhost:4310/setup). Enter the one-time token printed in the terminal, create the workspace and owner account, then restart `pnpm dev` and sign in. The generator configures embedded PostgreSQL for local development and includes the platform modules and an example module you can extend. [Getting started](docs/getting-started.md) · [Generator guide](packages/create-flowdular/README.md)

## Build with the sandbox

The sandbox is a separate chat-first application for building Flowdular modules. From an empty directory, one command creates `./flowdular`, starts the local application and prepares the sandbox connection:

```bash
npx @flowdular/sandbox
```

Open [127.0.0.1:4320](http://127.0.0.1:4320). If the new application needs first-run setup, follow the address and one-time token printed in the terminal. Then select a local Codex or Claude Code CLI, or configure a model provider key. In an existing Flowdular workspace, run the same command there or use `pnpm sandbox`. To clone an existing platform repository, pass `--connect <git-url>`. To connect to an application already running elsewhere, follow the [connection guide](docs/sandbox.md#connect-it-to-a-running-application).

Describe the business need in the sandbox. It turns the brief into a module specification and asks for decisions the request leaves open. After you approve the exact specification, specialists build the module in an isolated workspace. Checks run against the draft, and the preview renders its screens in the application shell with a separate database. You can then eject the source into your workspace or deliver a branch and pull request with the gate results. Connecting a repository does not publish a draft or deploy it to a running application.

[Sandbox guide](docs/sandbox.md) · [Sandbox package](packages/sandbox/README.md) · [Reference module](.ai/references/catalog)

## Deploy for your business

The application and its modules remain source code in your workspace. A team can review changes in Git, host the application for its users and keep its PostgreSQL data, object storage and encryption keys under its own operational control. A persistent server also keeps scheduled workflows and background jobs running between requests.

This repository provides a Docker Compose launcher with PostgreSQL and MinIO, Kubernetes manifests, a Render Blueprint, and an experimental Vercel web build. Render and Vercel need prepared external PostgreSQL with separate runtime, background and migrator roles, verified TLS, and S3-compatible object storage. Vercel also needs an always-on companion worker for scheduled jobs. Its web Functions still start background pollers, so the Vercel target is not ready for production traffic. These remote paths still need operator setup for secrets and data services.

From a Flowdular repository checkout, inspect the target before starting a local Docker stack:

```bash
pnpm flowdular deploy targets
pnpm flowdular deploy plan docker
pnpm flowdular deploy plan vercel
pnpm flowdular deploy start docker --apply
```

The start command requires a private interactive terminal because it displays the one-time setup token.

For Vercel, Render and Kubernetes, follow the operator setup in the [deployment guide](infra/README.md). [Operations and recovery](docs/operations.md) · [Configuration](docs/configuration.md)

## Contributing

Read [AGENTS.md](AGENTS.md) and choose the [task skill](.ai/skills/README.md) for your change. The same rules and procedures support human contributors, Codex and Claude Code.

```bash
pnpm verify      # rules, types, tests, validation and formatting
pnpm build       # CLI smoke checks and production application build
```

| Path                    | Purpose                                                          |
| :---------------------- | :--------------------------------------------------------------- |
| [`platform/`](platform) | Deployable application and module composition                    |
| [`modules/`](modules)   | Platform modules                                                 |
| [`packages/`](packages) | Contracts, database adapters, UI, CLI, sandbox and agent tooling |
| [`.ai/`](.ai)           | Shared rules, skills, specialist roles and blueprints            |
| [`infra/`](infra)       | Container and Kubernetes deployment assets                       |
| [`docs/`](docs)         | Guides, operations, architecture decisions and RFCs              |

## License

Flowdular is [MIT licensed](LICENSE).
