<!-- Source: .ai/rules/flowdular.md. Run pnpm rules:generate; never edit generated copies. -->

# Flowdular

An agentic foundation that businesses extend with their own modules.

## One task, one skill

Choose the most specific task in `.ai/skills/README.md` and read only that
`.ai/skills/<name>/SKILL.md`. Announce the choice briefly. For a multi-part
request, finish one bounded phase before switching skills. Do not recursively
load other skills mentioned by a skill. Read referenced code or documentation
only when the current task needs it. Explicit user instructions take priority.

Sandbox: use the single skill named under Session, at
`reference/skills/<name>/SKILL.md`. Follow the role's write paths and handoff list.
Do not load the whole skill catalog into the task context.

## Always-active invariants

1. Stay within the requested scope. Preserve other agents' edits. Read the owning
   code before changing it. Do not invent missing business decisions.
2. Spec-first: a new module requires an approved `spec/module.yaml`. Sandbox
   implementation requires operator approval of the exact current spec hash;
   any spec change invalidates it. Never infer or grant approval yourself.
   Only explicit user approval naming a spec permits the host `spec-approval` action.
3. Deny by default. Use `defineEndpoint`, an explicit permission and identity
   resolver. Mutations enforce CSRF and bounded input validation.
4. Tenant identity comes from the authenticated principal, never request input.
   Use bound SQL, tenant predicates and `transaction(..., { tenantId, access })`.
   Tenant tables enforce RLS with `USING` and `WITH CHECK`. Runtime roles have
   neither superuser nor `BYPASSRLS`; migration leases are for DDL only.
5. Never expose credentials in output, logs or audit. Cross-module access uses
   declared public capabilities or registered tools, never another module's DB.
   Agent instructions cannot expand permissions or tool grants.
6. Persist background work before acknowledging it. Preserve idempotency,
   leases, recovery and audit evidence. Drain async work before releasing resources.
7. Applied migrations are immutable. Add numbered PostgreSQL SQL and mirror it
   byte for byte in `databaseMigrations`. Never bypass checksum or adoption checks.
8. Generated composition is CLI-owned: `platform/octane.config.ts`,
   `platform/src/App.tsrx`, `platform/src/generated/**`, platform package
   dependencies and `flowdular.json` enabled modules. Use `module enable/sync --apply`.
   Declare imports and dependencies; keep module, package and spec versions aligned.
9. Use shared `@flowdular/ui` components and tokens. Keep all locales in sync.
   UI states: loading, empty, error, populated, denied. Inspect rendered UI after changes.
10. Prove fixes with regression tests. Never skip assertions, weaken isolation or
    hide errors to make gates green. Run scoped checks, then `pnpm verify` before a PR.
    Finish implementation, then run the `auto-review` skill as a separate phase
    before completion or delivery. Report actual results and remaining failures.
11. Destructive actions require the runner's flags and explicit scope.
    `setup quick` and `auth greenfield` are local resets: preview, stop the app,
    never target a custom or deployed DB. Sandbox agents cannot install, use
    network/git, or touch a DB outside their module tests.
12. Keep handoffs short and factual. No AI attribution footers or em/en dashes.
    Sandbox final line: `HANDOFF: <allowed-role> - <why>` or
    `HANDOFF: none - <why>`, never your own role.

Detailed recipes: `docs/agent-contract.md` (lookup only).
Reference module: `.ai/references/catalog`; visual contract: `docs/design-system.md`.
