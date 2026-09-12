# Skills

Flowdular is an agentic foundation framework: the platform is the foundation, and these skills are how a coding agent (a sandbox specialist or your own tool) builds on it correctly. Each `SKILL.md` is a procedure plus pitfalls, verified against the code it cites, with front matter `name` (equals the directory), `description`, `roles` (who reads it) and `when` (one line).

| Skill                   | One line                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `spec-interview`        | Interview a request into a v2 spec: capability card defaults, the questions protocol, decisions and out of scope.     |
| `module-new`            | Create a module from an approved spec: scaffold, what the scaffold lacks, server and client file sets, enable, grant. |
| `module-update`         | Change an existing module with a fixed touch list per change class and the version bump rules.                        |
| `spec-approval`         | Record explicit user approval of an exact current module spec without letting an agent approve its own work.          |
| `auto-review`           | Review finished changes against requirements, contracts and regression evidence before delivery.                      |
| `core-extend`           | Change a platform package without breaking modules, generated files, or the copies sandbox sessions read.             |
| `bug-hunt`              | Reproduce with the gate runner, map the symptom to its layer, fix there with a failing test, hunt siblings.           |
| `perf-audit`            | Hot paths of server, client, bundle and agent runtime; measure before changing anything.                              |
| `ux-design`             | The record-screen recipe, five states, component and class inventory, icon keys, copy rules.                          |
| `auth-security-review`  | Endpoint threat surface, scope model, API tokens, secrets, greps, destructive CLI rules, required tests.              |
| `test-hardening`        | Where tests run, the route recipe, the embedded PostgreSQL provider, required cases, break-the-implementation check.  |
| `migration-authoring`   | Numbered SQL, byte-identical constants, the checksum ledger, safe adoption, and immutable applied migrations.         |
| `database-adapter`      | Build a repository on the async provider contract: PostgreSQL SQL, provider leases, forced RLS, isolation tests.      |
| `translations-i18n`     | Live module bundles, fully qualified keys, locale-aware formatting, parity checks, and raw-key diagnosis.             |
| `cli-extension`         | Module CLI commands through `commands.json` and `defineCliExtension`, with the runner's approval rules.               |
| `agent-tool-design`     | Register module tools through the live composition registry with tenant, permission, input, output, and audit bounds. |
| `business-agent-design` | Ship a module-owned business agent with an exact tool ceiling, tenant binding, revisions, and access tests.           |
| `variables`             | Variable-aware fields and templates: the `{{ }}` contract, the scope mask, server-side resolution, adding a source.   |
| `workflow-development`  | Build, publish, invoke, simulate, and test typed durable workflows and their module integration capability.           |
| `release-eject-pr`      | Sandbox eject sequence, repository gates, branch and PR conventions, post-merge scope grant.                          |
| `deploy-operate`        | Container build, production env keys, migrations at rollout, health and readiness, backup and restore, rollback.      |

Choose one skill per task phase: the most specific matching entry above. For ordinary module work use `module-new` or `module-update`. Finish the phase before switching; do not recursively load other SKILL.md files mentioned in a skill. Consult relevant code and supporting references only as needed. `spec-approval` is host-only and requires an explicit user approval instruction.

The normal path for a module is one phase per step:

```text
request -> spec-interview -> operator approval (spec-approval) -> module-new -> auto-review
```

An existing module takes the same path with `module-update` in place of `module-new`. `spec-interview` reads `.ai/platform-capabilities.md` and asks for the decisions it cannot infer; implementation reads the approved spec and the touch list instead of scanning the repository, and reports anything the spec lacks as a spec defect.

Where they are read:

- Sandbox: copies are available in `reference/skills/`, but each turn receives exactly one Task skill selected by role, blueprint and request. An explicit `$skill-name` takes precedence only if installed and eligible for that role. Missing matches never load the whole catalog.
- Claude Code: RuleSync generates `.claude/skills` from this directory.
- Codex: RuleSync generates `.agents/skills` from this directory.
- Other tools: use the canonical skill here or add another RuleSync target in `rulesync.jsonc`.

Adding a skill: create `.ai/skills/<kebab-name>/SKILL.md` with the four front matter keys, keep the instructions focused, cite the owning code, add a row above and update the sandbox routing when applicable. Run `pnpm rules:generate` after formatting. `pnpm rules:check` verifies every generated copy.
