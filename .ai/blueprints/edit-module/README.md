# edit-module

Change an existing module. The sandbox labels these sessions `edit-module@1.0.0` (`packages/sandbox/src/server/routes.ts`) and copies the module into the session with a pristine `base/` copy for the diff; the same blueprint applies when a person or a coding tool follows `.ai/skills/module-update/SKILL.md` at the repository root.

`requiresApprovedSpec` is true. The copied specification describes the old module, so `business-manager` takes the first sandbox turn and writes the smallest delta needed for the request: a `specVersion` bump plus changed acceptance scenarios, invariants, permissions or ownership rules. The sandbox then shows that delta to the operator. Approval records a SHA-256 hash of the exact specification after the approval route changes its status to `approved`. An agent-written status line has no authority. Editing the specification or requesting changes clears the gate because its content no longer matches the recorded hash. Only then does the selected implementer start (`packages/sandbox/src/server/spec.ts`, `planning.ts`, `sessions.ts`).

Landing: eject runs the gates per module, copies added and changed files, removes the files the session deleted, runs `pnpm install`, `auth sync-scopes`, and a platform typecheck, and stops at the first failed step; `module enable` does not run for an existing module. A session may carry several modules. Direct path: `pnpm verify` and a pull request.

When the approved delta adds an agent tool or a module-owned business agent, `agentic-engineer` follows `agent-tool-design` or `business-agent-design`. Business agent definitions live in module source, register through `context.agentDefinitions`, and keep provider, model, and reduced enabled tools in the tenant binding.
