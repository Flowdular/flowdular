# Flowdular naming and existing installations

The project is Flowdular. Its public website origin is `https://flowdular.com`,
the intended repository is `https://github.com/flowdular/flowdular`, and packages
use the `@flowdular` npm scope. The application creator is `create-flowdular`.

## Commands and configuration

Use `pnpm flowdular` or its short alias `pnpm fd`. Workspace configuration lives
in `flowdular.json`. Create a new application with `npm create flowdular@latest`
once the renamed creator has been published.

Environment variable names use `FD_`. Flowdular 0.6 no longer reads `CL_`
values; rename them in `.env` files and deployment environments.

## Persistent data

Local state lives in `.flowdular`. Flowdular 0.6 no longer reads a `.coreloom`
state directory; a workspace that still has one starts with empty state under
`.flowdular`.

Run grants signed by the pre-rename issuer and the `x-coreloom-secret` and
`x-coreloom-read-permission` workflow schema markers are no longer accepted.
Mark secret fields with `x-flowdular-secret` and permission-protected fields
with `x-flowdular-read-permission`. Registering an agent tool whose input or
output schema carries any other `x-<vendor>-secret` or
`x-<vendor>-read-permission` key fails with `AGENT_TOOL_SCHEMA_MARKER_UNKNOWN`,
so a field still marked with the old name never reaches a workflow unprotected.

Authentication, setup, sandbox and preview cookies carry the `flowdular_` prefix
(`__Host-flowdular_session` behind HTTPS). Cookies set by 0.5 are not read, so
everyone signs in again; the browser drops the old ones when they expire.

## Database identifiers

Flowdular 0.6 renamed every database identifier that carried the old name:

| Identifier        | Before 0.6                                                     | From 0.6                                                          |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Roles             | `coreloom_migrator`, `coreloom_runtime`, `coreloom_background` | `flowdular_migrator`, `flowdular_runtime`, `flowdular_background` |
| Tenant setting    | `coreloom.tenant_id`                                           | `flowdular.tenant_id`                                             |
| Migration ledger  | `_coreloom_migrations_v2`                                      | `_flowdular_migrations_v2`                                        |
| Ledger lock       | `coreloom.migrations`                                          | `flowdular.migrations`                                            |
| Advisory lock key | `coreloom-migration`                                           | `flowdular-migration`                                             |
| Trigger function  | `coreloom_reject_change`                                       | `flowdular_reject_change`                                         |

The platform API moved to 0.2.0 because the ledger and lock constants changed,
and every module declares `"platformApi": "^0.2.0"`. A module is refused at
registration when it declares no `platformApi` or a range that also admits a
version before 0.2.0, such as `^0.1.0`, `*` or `>=0.1.0`.

The owner made a one-time exception to the rule that applied migrations are
immutable (decision of 2026-10-05): nobody runs Flowdular yet, so the released
migration SQL and its `databaseMigrations` mirrors were rewritten in place, and
there is no upgrade path. The rule itself is unchanged and applies to every
later migration.

Flowdular 0.6 refuses a database created by 0.5 or earlier with
`LEGACY_DATABASE` before it creates its ledger or applies anything: adopting
it would mark its tables complete while every policy reads a setting the
adapter no longer sets. `pnpm flowdular module validate`, the sandbox
module-rules gate and `pnpm flowdular migration verify` report the
script-level rule as well, without a database: a tenant policy must read
`current_setting('flowdular.tenant_id', true)`, and only `flowdular_*` roles
may be named.

## Resetting an existing installation

- Local embedded database: stop the platform and the sandbox, then delete
  `.flowdular/data/pglite` (or the `FD_DATABASE_PGLITE_DIRECTORY` directory).
  `pnpm flowdular setup quick --apply --confirm reset-local-auth` drops every
  table instead and seeds the demo accounts; the old roles and trigger
  function stay in the embedded cluster, unused. A sandbox session created before 0.6 keeps its
  own preview database, so its preview fails with the same refusal; delete
  the session.
- Docker Compose: `docker compose --env-file infra/docker/.env -f infra/docker/compose.yaml down -v`
  deletes the database volume; the next start initializes the new roles.
- PostgreSQL server: create a new database with the `flowdular_migrator`,
  `flowdular_runtime` and `flowdular_background` roles and point the
  `FD_DATABASE_*_URL` values at it.

## External services

Changing source references does not register a domain, create an organization,
transfer a repository, publish npm packages or deploy a website. Register
`flowdular.com`, create the GitHub and npm organizations, transfer the repository
and publish the renamed packages before announcing the new installation URL.
The checkout's existing Git remote stays usable until the repository transfer.

## Brand assets

The existing woven # symbol remains the brand mark. Its generated geometry,
generator and application favicons are unchanged; the wordmark reads Flowdular.
The edited raster assets are `packages/landing/public/og.png`, the corresponding
platform and sandbox `public/og.png`, and the five
`packages/landing/public/media/sandbox-*.png` screenshots.

Raster edits used the built-in image generation tool in edit mode. The prompt
requested only replacement of visible Coreloom text with Flowdular while
preserving fonts, colors, layout, data, icons and the original aspect ratio.
The preview screenshot was edited again with an explicit requirement to preserve
every horizontal and vertical bar, gap and rounded end of the original #.
Selected outputs were visually inspected and copied into the paths above.
