---
name: release-eject-pr
description: 'Land a module or core change: the sandbox eject sequence, the repository verification gates, the git branch and PR conventions, and the post-merge scope grant.'
roles:
  - module-executor
  - reviewer
  - backend-engineer
when: A change is ready to leave a sandbox session or a working tree and reach the platform.
---

# Eject, verify, deliver

Two paths reach the same place. The sandbox path is chat, gates, preview, eject. The direct path is a skill in your own coding tool, `pnpm verify`, a pull request. Both end with the module enabled through the CLI and its scopes granted.

## 1. Sandbox eject (`packages/sandbox/src/server/delivery/{local,steps}.ts`, `routes.ts`)

`POST /sandbox/api/sessions/:id/eject` with `{ apply: false }` returns the plan: for every module of the session the files that land in `modules/<dir>`, the files that would be overwritten, the files the session deleted and the eject will remove, packages a module declares that the workspace cannot resolve yet, the gates, and whether the connected application has to restart. With `{ apply: true }` the sandbox streams the steps:

1. Gates: `spec-schema` and `module-schema` once, then `dependencies`, `typecheck`, `tests`, `format` per draft module. Any failure stops the eject before a file is written (`EJECT_GATES_FAILED`).
2. Copy of each session module into `modules/<dir>`, then removal of the files an edit deleted (`removeModuleFiles`, empty directories included).
3. `pnpm install` at the workspace root.
4. `pnpm oerp module enable <id> --apply --json` for each new module (writes `coreloom.json`, `platform/package.json`, `platform/src/generated/*`, and grants the module's scopes itself).
5. `pnpm oerp auth sync-scopes --module <id> --apply --json` for each module (idempotent re-grant, needed for edited modules that added a permission).
6. `pnpm --filter @coreloom/platform typecheck`.
7. Optionally `pnpm build`.
8. A restart note: the connected application loads the new composition and runs new schema constants only at start, so a local `pnpm dev` restarts and a remote deployment redeploys.

A failing step stops the delivery there with the step's output; the session is marked delivered only when every step passed. Eject requires the connected grant to hold `sandbox.modules.eject`. Delivery targets sit behind one interface (`delivery/types.ts`); the request names one with `target: 'workspace' | 'git-pr'` (default from `coreloom.json`), `workspace` is the one above, `git-pr` is section 2.

## 2. Git delivery from a sandbox (`target: 'git-pr'`, `packages/sandbox/src/server/delivery/git-pr.ts`)

The pull request is the unit of a delivery: one session, one branch, one PR, every module the session touched. Nothing in the operator's working tree or index changes; the work happens in a detached worktree under `.coreloom/sandbox/worktrees/<session>` that is removed afterwards, whatever the outcome.

- Available when the workspace is a git work tree with at least one commit and the configured remote exists (`git rev-parse --verify HEAD`, `git remote get-url <remote>`); a repository without commits answers "make the first commit before delivering as a pull request". A PR is opened when `gh auth status` succeeds (a provider token sealed in the sandbox configuration is handed to gh as `GH_TOKEN`); otherwise the branch is pushed and the compare link shown.
- Branch `<branchPrefix>/<module-dir>-<session id first 8>` from `<remote>/<baseBranch>`: `git fetch`, `git worktree add --detach`, `git switch -C`.
- In the worktree: the copy and the removals, `pnpm install --offline` (fallback `--prefer-offline`), `pnpm oerp module enable <id> --apply` for each new module with the worktree as `--dir`, the platform typecheck.
- Guardrails before the commit: `git status --porcelain` in the worktree may list only `modules/<dir>/**` of the session's modules, `coreloom.json`, `platform/package.json`, `platform/src/generated/**` and `pnpm-lock.yaml`; the count stays within `sandbox.delivery.maxChangedFiles` or, unset, the `.ai/policies/task-budgets.yaml` figure for the session kind (`new-module` 30, `edit-module` 12, default 18); new packages within `maxNewDependencies` (0). Owners come from `.ai/policies/path-ownership.yaml`; with `crossOwnerChanges.requireReviewer` a cross-owner change asks for a reviewer from each owner in the body. A violation lists the offending paths and stops before anything is committed; the branch is deleted.
- Commit `sandbox: add|update <module id>` (author from git config) with the session id and the gate summary, `git push -u --force-with-lease <remote> <branch>`, `gh pr create --base <baseBranch> --head <branch> --title "Add|Update <module id>" --body-file <tmp>` (`--reviewer` from `git.reviewers`). A second delivery of the same session updates the branch and keeps the open PR.
- PR body, plain: two or three sentences from the brief and the last review handoff, `Session <id>.`, the gate table (gate, module, result), the file list grouped as added, modified, removed, `Post-merge: pnpm oerp auth sync-scopes --module <id> --apply` per module, the reviewer note. No attribution footers, no dashes.
- `sync-scopes` does not run in the worktree: it is a runtime action against the deployment database, so it stays the post-merge step. Deploy, run it with `OERP_AUTH_DATABASE` pointing at that database, verify the navigation entry appears for an owner.
- Configuration in `coreloom.json`, all optional and validated by `packages/contracts/schemas/project.schema.json`: `sandbox.delivery { default: 'workspace' | 'git-pr', targets: ['workspace', 'git-pr'], git: { remote: 'origin', baseBranch: 'main', branchPrefix: 'sandbox', provider: 'github' | 'none', reviewers: [] }, maxChangedFiles }`. Read at request time.
- The screen: "Into this workspace" / "As a pull request", offered only when both are usable here; an unusable target says why. The git plan shows branch, base, changed files against the budget, new packages, owners touched and the guardrail verdict; done shows the PR or compare link. `.coreloom/sandbox/sessions/<id>/delivery.json` keeps the branch and the URL.

## 3. Direct path from a working tree

```bash
pnpm oerp module enable <id> --apply          # new module only; also grants its scopes (result: scopes)
pnpm oerp auth sync-scopes --module <id> --apply   # re-grant after a new permission, or against another database
pnpm verify                                    # typecheck, test, validate, format:check
pnpm build                                     # cli build and smoke, module sync --apply, platform build
pnpm audit --prod --audit-level high           # what CI runs (.github/workflows/ci.yml)
```

`pnpm validate` runs `spec validate --all`, `blueprint validate --all` (every `.ai/blueprints/*/blueprint.json` plus its companion files) and `module validate`. It checks manifests and schemas, not behaviour; typecheck and tests are the evidence.

Branch names: `feat/<module>-<topic>`, `fix/<module>-<topic>`, `core/<package>-<topic>`. Commit one logical change per commit; generated files travel with the command that produced them.

## 4. PR conventions (repository rules)

- Short body: what changed and why in a few sentences, gotchas, one line on verification (`pnpm verify passes; pnpm build passes`). No file tables, no design essays, no restating the diff.
- No AI attribution: no `Co-Authored-By: Claude`, no `Generated with` footer.
- No em or en dashes anywhere in commits, PR titles or bodies.
- Generated files and `modules.enabled` change only through the CLI, and the PR says which command produced them.
- Changes to `packages/**` name the consumers that were migrated (`core-extend`).

## 4b. Pull request body template

```text
Adds inventory.core: tenant-scoped stock locations with read and manage scopes,
a list and create endpoint, a Locations screen with a drawer form, and a
dashboard KPI. Covers INVENTORY-LIST, INVENTORY-CREATE, INVENTORY-DENY,
INVENTORY-ISOLATION.

Generated by the CLI in this PR: coreloom.json and platform/package.json
(pnpm oerp module enable inventory.core --apply), platform/src/generated/*
(module sync), pnpm-lock.yaml (pnpm install).

Gates: spec-schema, module-schema, dependencies, typecheck, tests (7), format
all passed in the sandbox eject; pnpm verify and pnpm build pass locally.

Post-merge: pnpm oerp auth sync-scopes --module inventory.core --apply against
the deployment database.
```

## 4c. Pre-flight checklist

- `git status` shows only `modules/<dir>/**` plus the CLI-generated files named above.
- `module.json` `version`, `spec/module.yaml` `specVersion` and `package.json` `version` are equal.
- `spec/module.yaml` is `approved`; the PR does not change its status.
- No `console.log` left in module code; no secrets or tokens in tests.
- The PR title is under 70 characters and names the module (`inventory.core: stock locations`).

## 5. Container and tags

CI builds the image from `infra/docker/Dockerfile` on every PR (no push). A release tag `v*.*.*` is the trigger for publishing (workflow owned by the platform team); the image runs `node platform/dist/server/entry.js` with `/data` as the database volume and needs `OERP_AUTH_DATABASE`, `OERP_AGENTS_DATABASE`, and for `agents.core` `OERP_AGENT_CREDENTIAL_KEY` and `OERP_AGENT_RUN_GRANT_KEY` (required in production, not provided by `infra/docker/compose.yaml` or `infra/kubernetes/deployment.yaml` today).

## Pitfalls

- An eject removes the files a session deleted; a rename shows up as one removal and one addition in the plan.
- `module enable` runs `pnpm install` when the package is not linked; a failing install is reported as `pnpm install failed while linking the module package`. A failed scope grant after a successful enable is `MODULE_SCOPES_SYNC_FAILED`; rerun `auth sync-scopes`.
- `platform/.generated/` is a stale ignore entry; the live generated directory is `platform/src/generated/`.
- `pnpm oerp module sync --apply` is also run by `pnpm dev` and `pnpm build`; a dirty generated file after a checkout means the enabled list and the files disagree.
