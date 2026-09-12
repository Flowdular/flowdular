---
name: test-hardening
description: >-
  Make a module test suite prove behaviour: where tests live and run, the route
  recipe, the embedded PostgreSQL provider, the denial and isolation cases every
  endpoint needs, and the break-the-implementation check.
roles:
  - backend-engineer
  - frontend-engineer
  - reviewer
  - module-executor
  - agentic-engineer
when: A module has few or tautological tests, a bug escaped the suite, or a reviewer asks whether the tests guard the change.
---

# Harden a test suite

## 1. Where tests live and run

- `tests/module.test.ts` (one file per module today; more files are fine). `tsconfig.json` includes `src/**/*` and `tests/**/*.ts`, so a test file is `.ts`; `.tsrx` components are not compiled by vitest here. Testable client logic (formatting, filtering, mapping, state transitions) goes into a `.ts` helper next to the view and is imported by the test.
- Runner: `vitest run` (`pnpm --filter @flowdular/module-<dir> test`). In the sandbox the `tests` gate runs `vitest run --passWithNoTests` inside the module directory, so a module with no tests passes the gate. Treat an empty or trivial suite as a defect, not a pass.
- New modules use vitest 4.1.11, typescript 5.9.3 and `@types/node` 24.13.3. The catalog reference is an immutable older release; use the current scaffold dependency versions for new code.

## 2. Repositories on an embedded PostgreSQL

`createPgliteTestProvider()` from `@flowdular/database-testing` runs a real PostgreSQL inside the test process, with the same `coreloom_runtime` and `coreloom_background` roles and the same forced row-level security a deployment enforces. Booting it costs about two seconds, so a suite opens one provider per test file, migrates it once, and truncates the module's tables between cases; `.ai/references/catalog/tests/support/database.ts` is the shape (`createCatalogTestDatabase` hands out a lease per fixture, `closeCatalogTestDatabases` runs in `afterAll`). Build the service on top: `new CatalogService((await createCatalogTestDatabase()).repository)`. A database module also keeps `tests/migrations.test.ts` for SQL byte parity, fresh apply, safe pre-ledger adoption, and a clean second start. A module whose spec has no `database` capability gets a `MemoryXRepository` from the scaffold instead; a module with a database tests the database repository, never a hand-written fake, because the SQL, the ledger and the row-level security are what need testing.

## 3. Route recipe (from `modules/auth/tests/endpoints.test.ts`)

```ts
import { createContext } from '@octanejs/app-core';
import { createAuthenticationMiddleware } from '@flowdular/module-auth/server';
// build an AuthRuntime around a DatabaseAuthRepository on a createPgliteTestProvider() lease and a cheap scrypt cost,
// sign up through the auth sign-up route to obtain a cookie and csrfToken, then:
const routes = createCatalogRoutes(auth, runtime);
const create = routes.find(
	(route) =>
		route.path === '/api/catalog/items' && route.methods.includes('POST'),
)!;
const response = await create.handler(
	createContext(
		new Request('https://erp.example/api/catalog/items', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://erp.example',
				cookie,
				'x-csrf-token': csrfToken,
			},
			body: JSON.stringify(input),
		}),
		{},
	),
);
```

The auth middleware must have set the principal for `endpointIdentityFromContext` to find it: either run `auth.middleware(context, next)` before the handler or resolve the session and set `AUTH_PRINCIPAL_STATE_KEY` on `context.state` (both exported from `@flowdular/module-auth/server`). Read `modules/auth/tests/endpoints.test.ts` for the runtime shape (`cookie`, `settings`, `service`, `middleware`).

## 4. Cases every endpoint needs

- 401 `UNAUTHENTICATED`: no cookie, no bearer token.
- 403 `FORBIDDEN`: a principal whose scopes lack the permission.
- 403 on a mutation without `x-csrf-token` (`CSRF_REJECTED`) and without `origin` (`ORIGIN_REQUIRED`).
- 400 with the stable code for each validation bound (`INVALID_INPUT`, module codes such as `INVALID_ITEM_KIND`).
- 409 for the tenant-scoped uniqueness rule, and success for the same key in another tenant.
- Tenant isolation: rows created for `tenant-a` are invisible to `list('tenant-b')`. The provider hands the suite the non-bypass `coreloom_runtime` role, so this runs against real forced row-level security; also assert that a call without tenant context fails with `TENANT_CONTEXT_REQUIRED`.
- Identity: `moduleDefinition.manifest.id` equals the module id (keeps `module.json` and `src/index.ts` aligned). The scaffold writes this and the isolation case; everything else in this list is yours.

Assert at the observation boundary: status code, `error.code`, returned record fields. Do not assert internal helper names, call order, or SQL text.

## 5. Break the implementation

A regression test that never failed proves nothing. For each new test: comment out the guard it protects (`if (denial) return denial;`, the `WHERE tenant_id = $1`, the `UNIQUE` constraint), run the suite, confirm the test fails, restore the code. Record in the handoff which tests were verified this way.

## 6. Flake sources here

`Date.now()` in `createdAt` (sort by `sku`, not by time); `randomUUID()` ids (never assert them); scrypt with the default cost is slow, so tests pass `passwordHash: { cost: 2 ** 12, ... }` as `modules/auth/tests/endpoints.test.ts` does; two tests sharing one provider see each other's rows unless the tables are truncated between them, so take a fresh fixture per test from the file's `tests/support/database.ts` helper.

## 7. Landing

Sandbox: the `tests` gate output appears in the chat after your turn. Repository root: `pnpm --filter @flowdular/module-<dir> test`, then `pnpm verify` before a PR.

## Pitfalls

- `expect(() => service.create(...)).toThrowError(/active tenant/)` pins a message; prefer the error `code` (`DUPLICATE_SKU`) when the class exposes one.
- A test that imports `@flowdular/ui` pulls fonts and CSS; keep client tests to `.ts` helpers.
- `vitest run` picks up `tests/**/*.test.ts`; a `.spec.ts` name also works but keep one convention.
