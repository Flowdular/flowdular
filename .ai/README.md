# .ai

Flowdular is an agentic foundation framework. The platform under `packages/`, `modules/` and `platform/` is the foundation (accounts, workspaces, permissions, modules, agents runtime, CLI, sandbox); this directory is how agents build on it: shared RuleSync rules and skills, role prompts for the sandbox specialists, blueprints that describe each kind of change, and policies that document what the code enforces.

## What is consumed by what

| Path                                                         | Consumer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/*.md`                                                 | Canonical cross-agent instructions. RuleSync generates the root `AGENTS.md` and `CLAUDE.md` from these files; `pnpm rules:check` rejects drift.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `agents/sandbox/*.md`                                        | Loaded at sandbox start by `packages/coding-agent/src/roles/registry.ts` (`loadAgentRoles`); `gates`, `handoff` and `allowedPaths` are enforced. `dependencies` always runs, a `HANDOFF:` line must name a role from the list and never the role itself, and writes outside the active role allowlist are quarantined and restored before validation. Defaults in `packages/coding-agent/src/roles/defaults.ts` are regenerated from these files by `pnpm --filter @flowdular/coding-agent sync-roles`, and `tests/sync.test.ts` fails when they drift. |
| `agents/{module-executor,reviewer,spec-author}.md`           | Read by people and coding tools at the repository root; named in `blueprints/*/blueprint.json`. Not loaded by code.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `skills/*/SKILL.md`                                          | Canonical cross-agent procedures. They are copied into every sandbox session as `reference/skills/` (`packages/sandbox/src/server/reference.ts`) and RuleSync generates the discovery copies under `.agents/skills` and `.claude/skills`.                                                                                                                                                                                                                                                                                                               |
| `blueprints/*/blueprint.json`                                | `pnpm flowdular blueprint list` and `blueprint validate --all` (`packages/cli/src/runner.ts`, discovery in `packages/cli/src/validation.ts` `findNamedFiles`) validate every `blueprint.json` against `packages/contracts/schemas/blueprint.schema.json` and check the companion files exist; `pnpm validate` runs it in CI. The sandbox labels sessions `new-module@1.0.0` and `edit-module@1.0.0`.                                                                                                                                                    |
| `blueprints/*/*.yaml`, `*.schema.json`, `examples/`          | Existence-checked by `validateBlueprint`; otherwise documentation for agents and reviewers. Nothing executes `steps.yaml` or `gates.yaml`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `policies/capabilities.yaml`, `policies/model-routing.yaml`  | Existence-checked by `pnpm flowdular doctor`. The real policy is code: `packages/cli/src/capabilities.ts`, `modules/*/src/cli/commands.json`, `packages/cli/src/runner.ts`, `packages/sandbox/src/server/planning.ts`.                                                                                                                                                                                                                                                                                                                                  |
| `policies/task-budgets.yaml`, `policies/path-ownership.yaml` | Review guidance only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `examples/**`                                                | Reference shapes for agents; not compiled or tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`AGENTS.md` and `docs/design-system.md` are copied into each session's `reference/` as well (`packages/sandbox/src/server/reference.ts`). `AGENTS.md`, `CLAUDE.md`, `.agents/skills` and `.claude/skills` are generated compatibility outputs. Edit `.ai/rules` or `.ai/skills`, then run `pnpm rules:generate`.

## Using the skills from your own tool

The root carries only always-active invariants and the one-skill routing rule.
Detailed recipes live in `docs/agent-contract.md` as an opt-in reference. Each
sandbox turn receives one Task skill from `packages/coding-agent/src/roles/skills.ts`,
not the entire catalog. Character-budget and routing tests guard against prompt
growth; characters are a stable size proxy, not a tokenizer-specific cost estimate.

- Claude Code reads the generated `CLAUDE.md` and discovers the generated `.claude/skills` copies.
- Codex reads the generated `AGENTS.md` and discovers the generated `.agents/skills` copies.
- Any other tool: paste `AGENTS.md` and the skill into the instruction.

Both paths land the same way: gates, then `pnpm flowdular module enable <id> --apply` for a new module (it grants the module's scopes as its last step; `auth sync-scopes` re-grants later), `pnpm verify`, pull request (`skills/release-eject-pr`). A sandbox session is a pnpm workspace of its own with the draft modules as projects, so declared dependencies resolve for real and the `dependencies` gate runs after every turn.

## Adding things

- Rule: edit `rules/*.md`, then run `pnpm rules:generate`. Never edit generated root instructions directly.
- Skill: edit `skills/<kebab-name>/SKILL.md` with `name`, `description`, `roles`, `when`; keep it focused, verify API claims against the cited code, add a row in `skills/README.md`, then run `pnpm rules:generate`.
- Blueprint: a directory under `blueprints/` with `blueprint.json` valid against `packages/contracts/schemas/blueprint.schema.json` plus `README.md`, `input.schema.json`, `plan.schema.json`, `spec-requirements.yaml`, `allowed-paths.yaml`, `required-files.yaml`, `steps.yaml`, `gates.yaml` (all required by `validateBlueprint`), and `examples/valid`, `examples/invalid` (`input*.json` validate against `input.schema.json`, `plan*.json` against `plan.schema.json`). `agentRoles` use the role ids from `agents/`; `executorProfiles` use the profile ids in `policies/model-routing.yaml`; gate ids for module blueprints come from `packages/sandbox/src/server/gates.ts`.
- Sandbox role: `agents/sandbox/<id>.md` with the front matter `id`, `name`, `purpose`, `allowedPaths`, `gates`, `handoff` (see `agents/README.md`), then regenerate the bundled defaults: `pnpm --filter @flowdular/coding-agent sync-roles` (the script provided by `packages/coding-agent`; it rewrites `src/roles/defaults.ts` from these files) and run `pnpm --filter @flowdular/coding-agent test`.
- Policy: keep it truthful about what code enforces; name the file that does.

Formatting: `npx prettier --write .ai docs`, then `pnpm rules:generate`. No em or en dashes anywhere.

## Auto-review before delivery

After implementation, host agents run `auto-review` as a separate phase. The skill
requires requirement-to-test evidence, contract and security checks, lifecycle and
UI review, scoped tests, full verification and a core build. Host review remains
an instruction requirement; a model report alone cannot prove correctness.

Sandbox completion handoffs require an `auto-review` gate. A missing or stale
record routes the next turn to `$auto-review` with an empty write allowlist. The
server records a passing structured report only when that read-only turn leaves
module contents unchanged. The record includes a content hash and lives outside
the agent workspace. New edits invalidate it; findings route back to implementation.
The agent's assessment and deterministic gates are independent requirements.
Both delivery targets require per-module review plus complete passing gate results,
including tests with at least one test. Missing or skipped results block delivery.
Existing sessions need a current review before eject. Auto-continue uses the existing
session setting and turn budget; disabled auto-continue leaves a review handoff for
the operator to continue. No spec approval is granted by auto-review.
