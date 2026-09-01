---
id: module-executor
name: 'Module executor'
purpose: 'Implement one blueprint from the repository root, end to end, with the CLI and the gates run by hand.'
allowedPaths:
  - 'modules/{module}/**'
gates:
  - spec-schema
  - module-schema
  - dependencies
  - typecheck
  - tests
  - format
handoff:
  - reviewer
---

You run at the repository root (Claude Code, Codex, or a person following the same steps), not inside a sandbox session, so you may run commands. Nothing loads this file automatically; read it when you are asked to execute a blueprint. Paths are relative to the repository root, `{module}` is the module directory.

## Procedure

1. Pick the blueprint under `.ai/blueprints/<id>/` and read `README.md`, `steps.yaml`, `allowed-paths.yaml`, `required-files.yaml`, `gates.yaml`. Read the matching skill in `.ai/skills/<name>/SKILL.md` and `AGENTS.md`.
2. `pnpm oerp doctor --json` must report `healthy`.
3. For `new-module`: the spec must be `status: approved`. Run `pnpm oerp module new <id> --spec modules/<dir>/spec/module.yaml` (dry run), compare the planned files with `required-files.yaml`, then rerun with `--apply`. Add what the scaffold lacks (see the `module-new` skill).
4. Implement only what the spec's acceptance scenarios describe, inside `allowed-paths.yaml`. Copy the shape of `modules/catalog`.
5. Run the gates yourself, in the module directory: `pnpm --filter @coreloom/module-<dir> typecheck`, `pnpm --filter @coreloom/module-<dir> test`, `pnpm oerp spec validate --all --json`, `pnpm oerp module validate --json`, `pnpm format:check`. Check that every package imported under `src/` is declared in `package.json` (the sandbox does this with its `dependencies` gate; from the root, grep the imports).
6. Join the platform through the CLI only: `pnpm oerp module enable <id> --apply`, then `pnpm oerp auth sync-scopes --module <id> --apply`. Never edit `coreloom.json`, `platform/package.json`, `platform/src/generated/**` or `platform/octane.config.ts`.
7. `pnpm verify` at the root before you report.

## Refuse

A draft spec; a path outside the blueprint's allowed list; a new dependency the spec does not justify; a capability the runner answers with `APPROVAL_VERIFIER_REQUIRED`, `CONFIRMATION_REQUIRED` or `LOCAL_ONLY_CAPABILITY` (stop and report, do not work around it); waiving a gate.

## Report

State what changed (files), which gates ran with their exact commands and results, what the reviewer should look at, and what is deliberately deferred. End with `HANDOFF: reviewer - <what to review>` or `HANDOFF: none - <blocker>`.
