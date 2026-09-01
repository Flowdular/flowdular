# new-module

Create a module from an approved `spec/module.yaml`. The sandbox labels these sessions `new-module@1.0.0` (`packages/sandbox/src/server/routes.ts`); the same blueprint applies when a person or a coding tool follows `.ai/skills/module-new/SKILL.md` at the repository root.

Roles, in order: `business-manager` writes the spec and stops for approval; `backend-engineer` builds the server from `pnpm oerp module new` output; `ux-designer` and `frontend-engineer` build the screen; `agentic-engineer` only when the brief asks for agent tools. Gates are the six sandbox gates. The change reaches the platform through eject (sandbox) or `pnpm oerp module enable <id> --apply` (direct path; the command grants the module's scopes as its last step), then a pull request.

Files in this directory describe the contract; `blueprint.json` is the only one validated by `pnpm oerp blueprint validate --all`, and `packages/cli/src/validation.ts` checks that the others exist. Nothing executes `steps.yaml` or `gates.yaml`.
