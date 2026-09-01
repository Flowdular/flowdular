# edit-module

Change an existing module. The sandbox labels these sessions `edit-module@1.0.0` (`packages/sandbox/src/server/routes.ts`) and copies the module into the session with a pristine `base/` copy for the diff; the same blueprint applies when a person or a coding tool follows `.ai/skills/module-update/SKILL.md` at the repository root.

`requiresApprovedSpec` is false because the module already carries an approved spec; the change adds acceptance scenarios and bumps `specVersion` without a new approval round (`packages/sandbox/src/server/turns.ts`, `specApproval`). The first sandbox turn goes to `backend-engineer` (`planning.ts`, `classifyByRules`); later turns follow the handoff. `steps.yaml` carries one touch list per change class.

Landing: eject runs the gates per module, copies added and changed files, removes the files the session deleted, runs `pnpm install`, `auth sync-scopes`, and a platform typecheck, and stops at the first failed step; `module enable` does not run for an existing module. A session may carry several modules. Direct path: `pnpm verify` and a pull request.
