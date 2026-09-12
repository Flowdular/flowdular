---
name: auth-security-review
description: >-
  Review a module or platform change for authorization, tenancy, CSRF, input
  bounds, secrets, and destructive CLI use, with the exact checks and tests the
  platform relies on.
---
# Authentication and security review

## 1. Threat surface of a module endpoint

Check every route in `src/api/endpoints.ts` against `.ai/references/catalog/src/api/endpoints.ts`:

1. `defineEndpoint` (`packages/server/src/endpoint.ts`) with `access: { kind: 'permission', permission }` and `resolveIdentity: endpointIdentityFromContext`. `access: { kind: 'public' }` is allowed only with a written reason (health, sign-in). A raw `new ServerRoute` from `@octanejs/app-core` bypasses all of this; outside `modules/auth` and `packages/server` it is a finding.
2. Non-GET handlers call `sessionMutationDenial(octane, auth)` before any work. Order inside it (`modules/auth/src/server/session-security.ts`): API token principal (403 `TOKEN_MUTATION_DENIED`), `assertSameOrigin` (`sec-fetch-site`, then `origin`, then `referer`; 403 `CROSS_ORIGIN_REQUEST` or `ORIGIN_REQUIRED`), session cookie (401), `x-csrf-token` compared with `timingSafeEqual` (403 `CSRF_REJECTED`).
3. Body through `readJsonObject` (415 without `application/json`, 413 above 16 KB) and `requiredString`, `optionalString`, `requiredInteger` with `min` and `max`. A handler that calls `request.json()` itself has no size limit.
4. Tenant id only from `principalFromContext(octane)!.tenantId`. A `tenantId` read from the body, query or headers is a blocker (`.ai/examples/bad/tenant-from-body`).
5. Repository: every query on a tenant-owned table has `WHERE tenant_id = ?`; parameters are bound, never interpolated; unique constraints start with `tenant_id`.
6. Errors return `{ error: { code, message } }` with stable codes and safe messages; no stack, path, or SQL text reaches the client.

## 2. Scope model

`modules/auth/src/acl/scopes.ts`: `AUTH_SCOPES`, `PLATFORM_SCOPES` (`system.workspace.access` gates the shell in `platform/src/App.tsrx`; `system.settings.read` and `system.settings.manage` guard `GET /api/settings` (`system.settings.list`) and `POST /api/settings/update` (`system.settings.update`) in `modules/system/src/server/endpoints.ts`, from `SYSTEM_PERMISSIONS` in `modules/system/src/acl/permissions.ts`), `BUNDLED_MODULE_SCOPES`, `OWNER_SCOPES` (all of them), `MEMBER_SCOPES` (read scopes plus `agents.runs.execute`). Sign-up creates an owner with `OWNER_SCOPES`; member creation copies `OWNER_SCOPES` or `MEMBER_SCOPES` by role (`modules/auth/src/services/auth-service.ts`). A module's scopes reach existing owners through `pnpm flowdular module enable <id> --apply` (which runs the grant) or `pnpm flowdular auth sync-scopes --module <id> --apply` for a re-grant. Navigation in the `Development` group is owner-only in the client (`packages/client/src/shell/navigation.ts`); the server permission stays authoritative.

Review question: does every new scope appear in the spec `permissions`, in `src/acl/permissions.ts`, on the endpoint, and on the client contribution that exposes it?

### Unified audit read surface

Three tenant-scoped trails are readable over HTTP, each a GET behind a read scope with the tenant taken from the principal: `GET /api/auth/audit` (`auth.audit.read`), `GET /api/agent-audit` (`agents.runs.read`), and `GET /api/sandbox/audit` (`sandbox.sessions.read`). They are surfaced together in `auth.core`'s Administration > Audit view, whose source selector is derived from `ModuleClientContext.scopes` so a reader is never offered a source it cannot read. The agent and sandbox trails are hash-chained; `GET /api/agent-audit/verify` and `GET /api/sandbox/audit/verify` (same read scopes) recompute the chain and return `{ verified, brokenAt }` through the same repository walk the `flowdular <module> audit-verify` CLI uses, so CLI and endpoint cannot drift. Reviewing an audit change: the read scope guards both list and verify, the list cursor is `(occurred_at, sequence)` and the sequence is trusted from storage (never from input), and no chain field or metadata may carry a credential, token, or request body.

## 3. API tokens

`Authorization: Bearer clat_...` (`API_TOKEN_PREFIX` in `auth-service.ts`), 256-bit random, stored as SHA-256, scopes intersected with the live membership, max lifetime one year, resolved only when no session cookie is present (`modules/auth/src/middleware/authentication.ts`). Tokens are refused for session-guarded mutations. A module endpoint that should be callable by a token (read for the sandbox bridge) must be a GET behind a permission.

## 4. Secrets

Passwords: scrypt `N=2^17, r=8, p=1`, 64-byte key (`modules/auth/src/services/password.ts`). Sessions: 32 random bytes, CSRF 24 bytes, SHA-256 at rest. Cookies: `HttpOnly; SameSite=Strict; Path=/`, `Secure` and the `__Host-` prefix when `FD_AUTH_SECURE_COOKIE` is true (default in production), 12 hour TTL (`modules/auth/src/server/runtime.ts`). Provider credentials: AES-256-GCM in `modules/agents/src/services/credential-vault.ts`, key from `FD_AGENT_CREDENTIAL_KEY` (required in production). `redactSecrets` in `packages/ai-provider/src/errors.ts` scrubs provider messages; there is no general redacting logger, and a raw driver error can carry the failing statement, so a handler maps it to a Flowdular error code and logs that instead of `console.error(..., error)` with the driver message. A module never logs a principal, a token, or a request body.

## 5. Greps to run

```bash
grep -rn "new ServerRoute" modules/*/src | grep -v modules/auth          # raw routes outside auth
grep -rn "tenantId" modules/*/src/api | grep -v principalFromContext      # tenant from input
grep -rn "request.json()" modules/*/src                                   # unbounded body reads
grep -rn "console\.\(log\|error\)" modules/*/src                          # logging of principals or bodies
grep -rn "kind: 'public'" modules/*/src                                   # public endpoints need a reason
grep -rn "\${" modules/*/src/services/database-repository.ts              # interpolation into SQL
```

## 6. Destructive and external CLI capabilities

`packages/cli/src/runner.ts`: `external` risk and non-local `destructive` capabilities fail with `APPROVAL_VERIFIER_REQUIRED`; `localOnly` runs only when `FD_ENV` or `NODE_ENV` is `development` or `test` (unset counts as development); `requiresApprovedSpec` needs `--spec` pointing at an approved spec; `destructive` with `--apply` needs `--confirm <token>` equal to the descriptor's `confirmation`. `setup quick` is `auth greenfield` (`--apply --confirm reset-local-auth`) and resets `.flowdular/data/auth.db`. Never point it at `FD_AUTH_DATABASE` of a deployment.

## 7. Required tests per endpoint

Recipe in `modules/auth/tests/endpoints.test.ts`: build the runtime with a `DatabaseAuthRepository` on a `createPgliteTestProvider()` lease, call `route.handler(createContext(new Request(...), {}))`.

- 401 without a cookie or token.
- 403 with a principal that lacks the permission.
- Cross-tenant read returns an empty list (service level, on the suite's test provider under the non-bypass `coreloom_runtime` role).
- Mutation without `x-csrf-token` returns 403 `CSRF_REJECTED`; without `origin` returns 403.
- Each validation bound returns 400 with its code.

## 7b. Compliance table and report

Fill one row per endpoint before writing findings; a blank cell is a finding.

| Endpoint                        | Permission                   | Identity                      | Tenant source          | Mutation guard                | Body bounds                               | Tests               |
| ------------------------------- | ---------------------------- | ----------------------------- | ---------------------- | ----------------------------- | ----------------------------------------- | ------------------- |
| `POST /api/inventory/locations` | `inventory.locations.manage` | `endpointIdentityFromContext` | `principalFromContext` | `sessionMutationDenial` first | `readJsonObject`, `requiredString` max 32 | 401, 403, CSRF, 400 |

Report each finding as: severity (`blocker`, `should-fix`, `taste`), claim, `file:line`, the concrete scenario (who sends what, what happens), the rule (`AGENTS.md` number), the fix. Finish with a verdict: `approved` or `changes-required`. Do not fix code in the review run.

```text
blocker  Tenant id read from body   modules/inventory/src/api/endpoints.ts:41
         A member of tenant A posts { tenantId: "B" } and creates a location in B.
         AGENTS.md 6. Fix: principalFromContext(octane)!.tenantId; drop the field.
```

## 8. Known platform gaps to keep in mind (not module defects)

The sandbox server (`packages/sandbox/src/server/routes.ts`) has routes without authorization or CSRF, and the session id parameter is joined into paths unvalidated; the sign-in limiter is keyed on email plus `user-agent` (`modules/auth/src/server/endpoints.ts`, `limiterKey`); `users.members.manage` can create an owner because `role` comes from the body (`modules/users/src/api/endpoints.ts`); `emailConfirmation` does not gate sign-in; there are no security headers or a global body limit. A module review does not fix these; name them when a change touches the same area.

## Pitfalls

- `principalFromContext(octane)!` before `resolveIdentity` ran is a null dereference on a public route.
- A GET that mutates skips `sessionMutationDenial`; mutations are POST or PUT.
- A `secret: true` setting is write-only through `/api/settings/update`; a module never returns a setting value to the client unless its declaration says `client: true`.
- Matching a unique violation by message text is the accepted pattern, but the string must include the table name (`<table>.tenant_id`).
- An `Alert` with the raw server message is fine because the server already returns safe messages; never include the response body of a 500 verbatim.
