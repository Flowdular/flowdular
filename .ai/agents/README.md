# Agent roles

Two families of role prompts live here. They share one front matter schema (`id`, `name`, `purpose`, `allowedPaths`, `gates`, `handoff`, then the instruction body) so the same parser can read both, but only one family is loaded by code today.

## `sandbox/` runs inside the sandbox

`packages/coding-agent/src/roles/registry.ts` (`loadAgentRoles`) reads every `.md` in `.ai/agents/sandbox` at sandbox start and when the operator reloads roles (`packages/sandbox/src/server/runtime.ts`). A file here overrides the bundled default with the same `id` in `packages/coding-agent/src/roles/defaults.ts`; those defaults are regenerated from these files by a sync script (see `.ai/README.md`), so edit the markdown, not `defaults.ts`.

What the front matter does at run time:

- `gates`: enforced. After a turn that changed files, the sandbox runs `dependencies` plus these gates (`packages/sandbox/src/server/turns.ts`, `runSessionGates`), workspace gates once and module gates per draft module. Ids must come from `packages/sandbox/src/server/gates.ts`: `spec-schema`, `module-schema`, `dependencies`, `typecheck`, `tests`, `format`. An unknown id is dropped silently. The failing gate's command and output go into the fix prompt.
- `allowedPaths`: enforced after every turn. Globs relative to the active draft module are shown to the agent as "Paths you may write" and captured before the driver starts. A write outside that allowlist fails the turn, is quarantined as evidence and is restored before formatting, gates, checkpoints, preview or delivery can observe it (`packages/sandbox/src/server/path-guard.ts`, `turns.ts`).
- `handoff`: enforced. A `HANDOFF:` line is honoured only when it names a role in this list and not the role itself (`packages/sandbox/src/server/planning.ts`); otherwise the state routing decides and the transcript says why. The team list in the instruction is built from this list.
- `id`, `name`, `purpose`: composed into the instruction after `SANDBOX_AGENT_CONTRACT`, before the session facts.

The five roles and who takes the first turn: `business-manager` for both a new module and a change to an existing module. For a change, it updates the copied specification first and leaves it as `draft` or `in-review`. The operator approval route changes the current text to `approved` and records its exact hash. Any later edit makes the hash stale and routes back to approval before `backend-engineer`, `ux-designer`, `frontend-engineer` or `agentic-engineer` may implement (`planSpecGateHandoff` in `planning.ts`, `isSpecApproved` in `spec.ts`).

## Root roles run at the repository root

`module-executor.md`, `reviewer.md`, `spec-author.md` describe the same jobs for an agent working in a checkout with a shell (Claude Code, Codex, a person). No code loads them; `.ai/blueprints/*/blueprint.json` names them in `agentRoles` and `requiredReviewers`. Their `allowedPaths` are relative to the repository root and they run the gates themselves with the commands listed in each blueprint's `gates.yaml`.

## Adding or changing a role

1. Edit or add `.ai/agents/sandbox/<id>.md`. Keep the front matter keys exactly as above; `id` is the file name.
2. Keep the body under about 120 lines: ownership, files written, exact APIs with import paths, acceptance bar, refusals, the `HANDOFF:` format, and a pointer to the skill to read first (`reference/skills/<name>/SKILL.md` inside a session).
3. Run `pnpm --filter @coreloom/coding-agent sync-roles` so `packages/coding-agent/src/roles/defaults.ts` matches (never edit that file by hand), then `pnpm --filter @coreloom/coding-agent test`; `tests/sync.test.ts` fails on any drift.
4. `npx prettier --check .ai`.
