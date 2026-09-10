# Architecture review: module-owned web surfaces

Date: 2026-09-10. Scope: current working tree, including existing concurrent
changes, with HEAD observed as `320066c`. This is an architectural assessment,
not release approval or a complete security audit. No implementation files were
changed. Older review reports were not treated as evidence of current defects.

## Conclusion

Flowdular is a modular monolith with useful composition, dependency, database,
identity and background execution boundaries. Keep that structure. A module can
already register anonymous HTTP endpoints and return HTML in a `Response`.
The supported module frontend contract, however, only contributes authenticated
workspace views. A reusable public or independently laid-out web application
needs a platform extension; a blog is only one possible consumer.

## Current capabilities and evidence

- `packages/server/src/endpoint.ts:25`: explicitly public endpoints are supported.
  `modules/auth/src/middleware/authentication.ts:23` resolves identity when
  available and still calls the next handler for anonymous requests.
- `modules/auth/src/server/composition.ts:33`: module compositions expose
  `ServerRoute[]` and prepare/start/stop/dispose hooks. This permits standalone
  HTTP responses, not a typed module contribution of Octane `RenderRoute` pages.
- `packages/client/src/contributions.ts:71`: client contributions provide views,
  navigation, account menus and widgets. `platform/src/App.tsrx:85` composes them
  behind authentication; `App.tsrx:70` deliberately disables indexing.
- `packages/cli/src/module-sync.ts`: dependency-ordered server and client
  composition is generated. `packages/kernel/src/module-registry.ts` checks
  dependency compatibility. CLI installation now has artifact, lock, update and
  recovery code; the selected distribution tests pass. Actual remote release
  availability was not checked.
- `packages/database/src/contracts.ts:52` provides tenant-scoped transactions.
  The selected provider-security suite proves tenant visibility and restricted
  role/ledger behavior with embedded PostgreSQL. It does not prove a public
  tenant resolver, which does not exist in the inspected composition contracts.
- `packages/kernel/src/capability-registry.ts` supports inter-module service
  registration; agents and workflows use these services through composition.
  These are internal module APIs, not anonymous internet APIs.

## Findings

### F1. Missing first-class web surface contract (required feature gap)

The server composition accepts only `ServerRoute[]`; client composition feeds the
workspace. The module schema exposes server/client flags but no page entries,
layouts or mount declarations. Octane itself has separate `RenderRoute` and
`ServerRoute` classes with SSR, layout and hydration support. A runtime check
confirmed that `RenderRoute` is not a `ServerRoute`.

Consequently, returning manually constructed HTML is possible today, but it does
not establish a supported module page build, asset and hydration pipeline.
Introduce declarative page entries and generate their registration through the
CLI and SDK. Test installed source modules in both development and production.
Do not require module authors to edit the platform composition files.

### F2. Anonymous tenant resolution has no platform contract (security prerequisite)

`PlatformServerContext` offers auth and databases but no published-site registry
or trusted mount-to-tenant resolver. Existing business endpoint rules take tenant
identity from the authenticated principal. An anonymous visitor has no principal.

Add an operator-controlled binding from a site address to a tenant and module
surface. The incoming path/host is only a lookup key, never authority to select
an arbitrary tenant. Unknown, disabled and conflicting bindings must fail closed.
Keep the site tenant independent of a signed-in visitor's active workspace.
Apply tenant transactions and module-owned public visibility rules together:
RLS alone does not distinguish published data from private drafts in one tenant.

### F3. Routes have no ownership/conflict gate (P2)

`platform/octane.config.ts:146` directly flattens module routes into the router.
The inspected Octane router sorts by specificity and takes the first match. A
direct executable check registered `/review/:id` and `/review/:slug` for GET:
registration succeeded and the first route won. No Flowdular ownership check is
performed at this composition point.

Adding modules with overlapping URLs can silently hide a route. A shared mount
registry should reject equivalent patterns and protected namespace conflicts,
reserve `/app`, `/auth` and platform API paths, and define intentional precedence
for nested routes and wildcards. Existing slug-first compatibility routes must
be accounted for when adding public paths. Host routing is a separate binding
requirement; the current router matches method and pathname.

### F4. Request draining ends before streamed bodies finish (P2)

`platform/src/server/lifecycle.ts:89` decrements the active request count as soon
as `next()` returns a `Response`. A response may still be producing its body.
A direct check returned an open `ReadableStream`, retired the lifecycle and
observed disposal while `response.bodyUsed` was still false.

This can close module resources during a reload while SSR, SSE or another
streaming handler still needs them. The installed Octane renderer streams SSR.
Track stream completion, error and cancellation as part of resource ownership.
The check demonstrates the lifecycle boundary, not an end-to-end production SSR
failure. Existing lifecycle tests pass but do not cover this case.

### F5. Protected endpoint configuration can fail open at runtime (P2)

`packages/server/src/endpoint.ts:77` decides whether to authenticate from the
presence of `resolveIdentity`, rather than from `access.kind`. Calling the
function from JavaScript with `access.kind = permission` and no resolver reached
the handler anonymously and returned HTTP 200 in a direct executable check.

TypeScript rejects that object in correctly typed source. This finding concerns
malformed module configuration crossing a runtime boundary, not a demonstrated
remote bypass of a correctly configured production endpoint. Reject invalid
definitions at registration and dispatch authorization from the access policy.
Public access should require an explicit, valid public declaration.

## Other architecture considerations

- Composition types live in `auth.core` and expose its concrete runtime. Move
  the neutral composition and web surface contracts into a platform-owned API
  as that API grows. Keep authentication an explicit service dependency.
- Installed modules share the host process and receive environment and database
  provider access. Module conventions and tenant RLS do not sandbox malicious
  installed code. This is a trusted extension model with a shared deployment
  and failure domain, consistent with the current source installation approach.
- `modules/auth/src/services/settings-store.ts:18` documents asynchronous loads
  behind synchronous snapshots, including an initial default-value window.
  Snapshots are local to a process. Do not use that implicit behavior for routing
  ownership or public-access decisions. Such decisions need an awaited,
  authoritative read and a defined invalidation policy. Multi-instance settings
  consistency was not tested in this review.
- Public traffic needs explicit caching and abuse-control policies, safe error
  responses and public asset handling. Auth-specific throttling does not define
  protection for arbitrary module endpoints. Custom-domain DNS/TLS provisioning,
  operational restore and production load were outside the executed checks.

## Recommended extension

Keep these concerns independent:

1. **Presentation:** a workspace contribution or a module-owned web entry/layout.
2. **Access:** public, authenticated or permission-gated. An independent web
   application may still require authentication.
3. **Mount:** operator-selected path and, later, an approved hostname binding.

A module can contribute any combination of backend endpoints, workspace
administration and one or more independent web surfaces. Core owns registration,
reserved paths, trusted site context and build integration. The module owns its
content, layout and business visibility rules. Reusing design-system primitives
must not force a public site to render the dashboard shell.

Start with tenant-bound path mounts such as `/sites/acme/<surface>`, arbitrary
nested page routes, module page entries, SSR/hydration, metadata, true HTTP 404s,
and public/private data loaders. Preserve current authenticated behavior. Add
host/subdomain mounts with domain ownership verification and infrastructure
integration as a separate phase. A configured default tenant binding can cover
a single-tenant installation.

Keep anonymous writes explicit too: forms, bookings or submissions need bounded
input, abuse protection and a deliberate audit identity contract. Do not invent
an authenticated user or grant broad service permissions to anonymous visitors.

Acceptance evidence should include anonymous rendering and hydration, deep-link
refresh, two tenants using the same content slug, an authenticated visitor from
another tenant, private/draft denial, mount conflicts, unknown/disabled sites,
uninstall/disable behavior, cancellation during streaming and a packed SDK
consumer build. Cache keys must include site/tenant and visibility context;
private responses must never populate anonymous caches.

## Executed verification

| Command                                                                                                                            | Result                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `pnpm --filter @flowdular/server test`                                                                                             | 10 passed                      |
| `pnpm --filter @flowdular/kernel test`                                                                                             | 51 passed                      |
| `pnpm --filter @flowdular/cli exec vitest run tests/module-sync.test.ts tests/module-validate.test.ts`                             | 23 passed                      |
| `pnpm --filter @flowdular/cli exec vitest run tests/module-distribution.test.ts`                                                   | 12 passed                      |
| `pnpm --filter @flowdular/platform exec vitest run src/routing.test.ts src/server/boot-shell.test.ts src/server/lifecycle.test.ts` | 20 passed                      |
| `pnpm --filter @flowdular/database exec vitest run tests/provider-security.test.ts`                                                | 18 passed, embedded PostgreSQL |
| `pnpm --filter @flowdular/module-auth exec vitest run tests/identity.test.ts`                                                      | 11 passed                      |

Total: 145 selected tests passed. Additional direct Node checks reproduced F3,
F4 and F5 without modifying production code or existing tests.

No full `pnpm verify`, platform build, browser session, external PostgreSQL run,
remote deployment or complete security audit was performed. There is no rendered
change to inspect in this review. The public-surface acceptance scenarios remain
unimplemented and unverified. This report is not a passing release verdict.
