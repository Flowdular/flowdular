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

PostgreSQL role names, the migration ledger, tenant context setting, migration
lock identity and authentication cookies retain their established identifiers.

Run grants signed by the pre-rename issuer and the `x-coreloom-secret` and
`x-coreloom-read-permission` workflow schema markers are no longer accepted.
Mark secret fields with `x-flowdular-secret` and permission-protected fields
with `x-flowdular-read-permission`.

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
