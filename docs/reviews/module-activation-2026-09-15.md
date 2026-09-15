# Per-workspace module activation from the admin UI (2026-09-15)

Decision (owner, 2026-09-14, item 4): enabling modules must be available from
the admin UI. The composed module set stays CLI-owned and baked at build; what
the UI changes is per-workspace activation of the modules the application
already composes.

## What landed

- `system.core` 0.8.0 (spec approved, schema 2): entity `module-activation`,
  table `system_module_activations` under forced row-level security, migration
  0001, endpoints `GET /api/system/modules/active`, `POST
/api/system/modules/activate` and `/deactivate` behind `system.settings.manage`
  with CSRF, and the module list on Administration, Modules with version, state,
  dependents, a confirm dialog and refusal reasons. The module now declares the
  `database` capability.
- Rules: `system.core`, `auth.core`, `users.core` and `profile.core` are
  required (`REQUIRED_MODULE_IDS` in `@flowdular/contracts`); a module another
  active module depends on is refused with 409 `MODULE_HAS_ACTIVE_DEPENDENTS`
  naming the dependents; a required module with 409 `MODULE_REQUIRED`;
  activating with an inactive dependency with 409 `MODULE_DEPENDENCY_INACTIVE`.
  Each change appends one `system.module.activated` or
  `system.module.deactivated` audit event; repeating the current state writes
  nothing.
- Enforcement: the generated composition binds every route to its module id
  (`bindModuleCompositions`), `defineEndpoint` answers 403 `MODULE_INACTIVE`
  after the permission check for an inactive optional module in the
  principal's workspace, and the application shell hides the contributions of
  inactive modules (`contributionsForActiveModules`); a failed read shows every
  module. The per-tenant snapshot is memoised for 30 seconds and published as
  the capability `system.modules.v1`.
- Platform API 0.1.9; every dependent range on `system.core` moved to `^0.8.0`.

## Not covered

- The agent tools of an inactive module are still offered: the harness
  registry has no per-tenant module hook. Recorded in `docs/deferred.md` once
  PR #14 lands.
- A change made on one instance reaches another instance after the snapshot
  expires (30 seconds).

## Gates

Scoped: system 49, server 305, client 90, cli 196, contracts 23 tests;
`pnpm typecheck`, `module validate`, `spec validate --all`, `format:check`
clean. Full `pnpm verify` in the agent worktree stops in
`packages/sandbox/tests/preview-worker.test.ts`: the isolated worker resolves
`@flowdular/sdk` through the parent directory into the main checkout's
`node_modules`, outside its read allowlist. That is an artifact of a worktree
placed under `.claude/worktrees` inside the repository, not a code defect; CI
on the pull request is the authoritative run.
