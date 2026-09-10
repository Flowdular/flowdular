# Module web surfaces and configurable backoffice: final review

Scope: the requested web-surface, backoffice routing and setup changes, including
F1-F5 from `public-module-surfaces-2026-09-10.md`. Other workspace changes are
not included in this verdict. No module specification was approved, no business
module was enabled. Npm publication remains the release owner's operation.

## Behavior and evidence

| Requirement                                                    | Implementation                                                                                                                      | Executable evidence                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable module pages with their own layout and backend loader | `packages/contracts/src/web.ts`, `packages/server/src/web.ts`, `packages/client/src/web.ts`; optional `ModuleServerComposition.web` | `packages/server/tests/web.test.ts`, `packages/client/tests/web.test.ts`, production `scripts/smoke-web.mjs`                                                                       |
| Public `/`, custom `/blog`, dashboard `/backoffice`            | `createModuleWebRoutes`, `createApplicationRoutes`, generated application setting                                                   | `packages/server/tests/application-routes.test.ts`; production smoke builds with `/app`, starts with `FD_APPLICATION_PATH=/backoffice`, checks both frontends and legacy redirects |
| Setup chooses and stores the backoffice address                | `platform/src/server/setup/{routes,page,index}.ts`; environment overrides generated default                                         | `platform/src/server/setup/routes.test.ts`: `/backoffice` survives review and is written to `.env`; invalid/reserved and overlapping paths are rejected before provisioning        |
| Navigation and authentication use the chosen address           | `packages/client/src/routing.ts`, shell links, auth client API and OIDC callback, both platform App entries                         | `packages/client/tests/routing.test.ts`, platform typecheck, production SSR/hydration smoke, clean SDK consumer typecheck                                                          |
| Tenant and access isolation                                    | Explicit operator mount owns tenant; public identity is null; protected pages compare principal tenant and permission before loader | `web.test.ts`: same slug in two tenants, spoofed query ignored, missing identity, wrong tenant, missing permission, draft 404, disabled/removed modules, write rejection           |
| Detect equivalent route patterns (F3)                          | `assertRouteConflicts` runs during platform composition                                                                             | Regression rejects GET `/thing/:id` plus GET `/thing/:slug`, permits distinct methods                                                                                              |
| Drain streamed responses (F4)                                  | Shared `trackResponseBody`, root platform lifecycle middleware                                                                      | `platform/src/server/lifecycle.test.ts`: resources remain alive through completion, cancellation, failure and request abort                                                        |
| Reject malformed endpoint authorization (F5)                   | Runtime policy validation in `defineEndpoint`                                                                                       | `packages/server/tests/endpoint.test.ts`: missing resolver and invalid access cannot invoke the handler                                                                            |

## Review checks

- Correctness: checked registration, mount precedence, disabled root behavior,
  legacy `/app` redirects with query preservation, DTO hydration, setup validation
  and persistence, and generated server/client configuration. Review found an
  immutable `Response.redirect()` header bug. The new regression first returned
  500 instead of 302; copying response headers fixed it. HEAD responses cancel a
  loader-provided body before discarding it.
- Security: no request parameter selects the public tenant. Protected loaders
  receive a validated identity only after access checks; public loaders always
  receive null identity. Only explicit DTOs enter HTML, with script terminators
  escaped. HTML/JSON and loader responses use no-store. Existing setup token and
  CSRF checks remain in place; invalid paths never reach provisioning. No SQL,
  RLS policy or applied migration changed in this scope. Module services must
  still enforce published-record visibility within the bound tenant.
- Compatibility: composition members are optional; auth retains aliases for the
  shared server contracts. Reviewed CLI generation, SDK exports, declared server
  dependencies, both App entries and the starter config. `client/web` and
  `client/routing` are browser-safe subpaths. A clean consumer installed the
  actual packed artifacts and passed types, module tests and export/dependency
  boundary checks. The release owner subsequently requested version 0.2.0; the public package
  manifests and generated SDK/CLI dependency pins were updated together.
- Lifecycle and cost: mount validation is O(m²), capped at 256 mounts; page
  ambiguity validation is O(p²) per surface, capped at 128 pages. Route conflict
  indexing is linear in route/path size. Root request namespace checks are O(m).
  JSON DTOs are limited to 1 MiB; HTML insertion buffers the head rather than the
  full response. Retirement owns response consumption and detaches its abort
  listener. No new background queue, retry mechanism or database resource is
  introduced. A real build exposed build-time module activation retaining the
  process; bundling now retires declarations before starting runtime services.
- UI: inspected the setup field, label, value and explanatory text in the browser.
  Inspected production `/backoffice` with a link to the runtime-selected path,
  public `/`, and a separately laid-out module page. Button hydration and Enter
  interaction worked; browser error logs were empty. Fixtures used no real tenant
  data. Denial, empty/missing content and loader failures are covered at the HTTP
  boundary; individual business pages own their rendered states and translations.

## Commands and outcome

- `VITEST_MAX_WORKERS=1 pnpm verify`: exited 0, with 1,290 passing tests and three existing opt-in
  PostgreSQL integration tests skipped because no external migrator URL was set.
  Those database reset/history suites were not changed; no claim is made about
  their execution. The earlier concurrent run failed two sandbox tests; both
  passed in the full rerun, including all 246 sandbox tests.
- `pnpm --filter @flowdular/server test`: final suite passed all 42 tests after
  the immutable redirect and HEAD cleanup changes.
- `pnpm build`: client and server builds completed and the process exited 0
  after the build-time lifecycle correction.
- `pnpm exec node scripts/smoke-web.mjs`: final production integration passed,
  including root, `/blog`, `/backoffice`, tenant separation and legacy redirects.
- `pnpm release:pack`: packed exactly `@flowdular/sdk`, `flowdular`, and
  `create-flowdular` locally.
- `pnpm release:smoke`: passed clean-consumer typechecks, 11 example-module tests,
  sandbox launcher and browser dependency/export boundary checks. The browser
  build included no server, database, agent, sandbox or core-module code.
- Scoped `git diff --check`: passed.

Verdict: pass for the requested implementation. No unresolved actionable finding
remains in this scope. Custom hostname/DNS/TLS provisioning and shared caching
remain outside this path-routing implementation. The three opt-in external
PostgreSQL tests remain unexecuted, as stated above. See
`docs/module-web-surfaces.md` for configuration and module-author guidance.

## 0.2.0 release and dependency remediation

The release owner requested all pending repository changes to be committed and
pushed to `Flowdular/flowdular`. Public manifests (`@flowdular/sdk`, the CLI
published as `flowdular`, and `create-flowdular`), the root version, scaffold
SDK/CLI pins and SDK adaptation defaults are set to 0.2.0. Independent module
manifest/spec versions and the immutable catalog reference retain their own
versions. The pinned reference is documentation, not an installed dependency.

The initial production audit found
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) through
`tsx` and `esbuild`. Updating `tsx` to 4.23.13 and direct build-tool pins to
`esbuild` 0.28.2 removed affected versions. The full development audit additionally
found [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) in
Vitest and its mocker. Vitest is now 4.1.11 across workspace packages, generated
modules and the starter. The source test guidance was updated and its copies
were regenerated with `pnpm rules:generate`; the historical reference was not
rewritten. Full `pnpm audit --audit-level low` now reports no known vulnerabilities.

Before staging, the tracked and nonignored file set was checked for private-key
blocks, common credential token formats, credential/database archive filenames,
and files larger than 20 MiB. No matches were found. This is a bounded check of
the files being delivered, not a claim that every possible secret format can be
detected. Local environment, runtime state, dependencies, build output and
release tarballs are excluded by the repository ignore rules.

Final checks after the 0.2.0 and dependency updates: the complete verification
passed with one worker per package, keeping every assertion and timeout intact.
The detached-turn regression also passed independently (12 route tests). Build,
production web smoke, packaging and clean-consumer SDK smoke all exited 0 on the
final source. Both repository and clean-consumer `pnpm audit --audit-level low`
reported no known vulnerabilities. The three packed manifest entries all name
version 0.2.0. The final review found no remaining defect in these release changes.
