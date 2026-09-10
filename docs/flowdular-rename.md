# Flowdular naming and existing installations

The project is Flowdular. Its public website origin is `https://flowdular.com`,
the intended repository is `https://github.com/flowdular/flowdular`, and packages
use the `@flowdular` npm scope. The application creator is `create-flowdular`.

## Commands and configuration

Use `pnpm flowdular` or its short alias `pnpm fd`. Workspace configuration lives
in `flowdular.json`. Create a new application with `npm create flowdular@latest`
once the renamed creator has been published.

Environment variable names use `FD_`. The platform and CLI also accept existing
`CL_` values; an explicit `FD_` value takes precedence. Existing `.env` files are
not rewritten, so credentials and custom database URLs remain intact.

## Persistent data

New workspaces use `.flowdular`. Existing workspaces with `.coreloom` continue
using that directory for their database, vault keys and sandbox history. If both
roots exist, startup refuses to select one silently. To change the directory
name, stop all platform and sandbox processes first, keep a backup, then rename
the complete directory. Update any explicit paths in the deployment environment.
Stored session source snapshots retain the dependencies of their original
revision; the rename does not rewrite historical drafts.

PostgreSQL role names, the migration ledger, tenant context setting, migration
lock identity and authentication cookies retain their established identifiers.
They are persistence and security contracts, not branding. Historical SQL and its
embedded migration definitions remain unchanged. Old signed run grants and
`x-coreloom-*` workflow redaction rules continue to be accepted with the same
signature, expiry and permission checks.

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
