# Core starter and sandbox review

Verdict: pass. Base: a4532b7. Reviewed implementation, generated composition, callers, regressions and release manifests on 2026-09-10.

## Behavior and compatibility

The generator now enables the platform's nine core modules plus the existing example. Template composition and enabled modules were written by the CLI's `enableModule` implementation against an installed SDK, without database seeding in the template. The scaffold test compares the generated enabled set with the platform set. No Official Modules business package was added.

`packages/cli/src/runner.ts` synchronizes declared permissions only after successful applied local demo initialization, using the existing guarded auth command for each enabled module. Preview still returns before any grants. `modules/auth/src/cli/index.ts` discovers specifications beside installed SDK auth as well as local modules; the installed-scopes regression failed before the fix and passed afterward. No applied SQL migration, module specification or HTTP authority contract changed. The generator, SDK and CLI are 0.2.2; sandbox is 0.2.3.

## Security and lifecycle

Font serving in `packages/sandbox/vite.config.ts` adds only the two resolved font asset directories. It does not allow the npm cache or disable Vite filesystem checks. The installed-package HTTP test reproduced 403 before the fix and now compares downloaded font bytes with the installed files.

The default platform URL uses localhost, matching IPv4 or IPv6 development listeners. The real IPv6 regression reproduced ECONNREFUSED with the former IPv4 literal and passes with localhost. Existing configured URLs and tokens are preserved: changing defaults does not replay a token to another configured host. Loopback still requires platform token authentication and sandbox authority.

Permission grants retain the existing owner-grant implementation and run sequentially after database reset cleanup. Specification scanning is O(number of local and SDK modules) per enabled module; the fixed starter has ten modules. No background task, retry loop or long-lived resource was introduced. The loopback test closes its listener, and package smoke terminates its owned server.

## Presentation

Generator and setup output use spaced headings and commands, with color only in a capable terminal outside CI and NO_COLOR. Public demo credentials remain distinct lines; the development-only notice remains visible without a WARNING prefix. Setup evidence remains in JSON rather than the human summary. Errors and non-setup output retain their previous behavior. Terminal previews inspected local setup, installed and uninstalled generator states, color and plain output. JSON retains evidence without ANSI. Node's experimental TypeScript warning is unchanged.

## Verification

- Generator tests: 34 passed. CLI output tests: 5 passed. The old output assertion incorrectly rejected a human heading containing configured; it now rejects the actual internal JSON field instead.
- New installed-SDK scope and real IPv6 listener regressions passed after observed failures before their fixes.
- `pnpm verify` and `pnpm build`: passed on the final implementation.
- `pnpm release:pack` and `pnpm release:smoke`: passed. A fresh tarball consumer initialized all core modules, served the login page and authenticated its owner with sandbox, workflow and automation read permissions. Standalone sandbox HTTP state, SSR, font downloads and isolated preview passed.
- Logs: `/tmp/final-core-verify.log`, `/tmp/final-core-build.log`, `/tmp/final-core-pack.log`, `/tmp/final-core-smoke.log`.

No actionable findings remain. Review is an assessment, not a correctness guarantee. The existing blog received sandbox module activation through the CLI and scope synchronization while stopped, then restarted on IPv4. Its saved token is rejected by the platform; the operator must issue and paste a new token. No authorization bypass or demo reset was performed to repair the connection. The full starter module set applies to newly generated applications.
