# Coreloom for Claude Code

Coreloom is an agentic foundation framework: the repository ships the foundation platform (accounts, workspaces, permissions, modules, agents runtime, CLI, sandbox) and you build a business platform on top of it, either in the sandbox with AI specialists or here, with the skills below. Read `AGENTS.md` for the contract before changing anything; `modules/catalog` is the reference module and `docs/design-system.md` the visual contract.

## Skills (`.ai/skills`, also `/name` through `.claude/skills`)

- `/module-new`: a module that does not exist yet, from an approved `spec/module.yaml`.
- `/module-update`: any change to an existing module (endpoint, table, column, screen, widget, permission).
- `/core-extend`: anything under `packages/**`, `platform/**`, or the schemas in `packages/contracts`.
- `/bug-hunt`: a defect, failing gate, wrong status code, or blank screen.
- `/perf-audit`: a slow screen or endpoint, or a review asking whether a change scales.
- `/ux-design`: a screen, drawer form, widget, or copy.
- `/auth-security-review`: any endpoint, scope, token, credential, or CLI capability change.
- `/test-hardening`: thin or tautological tests, or a bug that escaped the suite.
- `/migration-authoring`: a new table, column, index, or constraint.
- `/translations-i18n`: locales or translation files.
- `/cli-extension`: an operator command for a module.
- `/agent-tool-design`: an agent, tool, or automation on top of a module.
- `/release-eject-pr`: landing a change (sandbox eject, `pnpm verify`, pull request).

## Commands

```bash
pnpm oerp doctor --json                                          # workspace health
pnpm oerp module new <id> --spec modules/<dir>/spec/module.yaml  # dry run; add --apply
pnpm oerp module enable <id> --apply                             # composition, platform dependency, pnpm install, scope grant
pnpm oerp auth sync-scopes --module <id> --apply                 # re-grant scopes later (new permission, other database)
pnpm oerp module validate --json                                 # manifests, composition entries, translations
pnpm --filter @coreloom/module-<dir> typecheck && pnpm --filter @coreloom/module-<dir> test
pnpm verify                                                      # typecheck, test, validate, format:check
pnpm dev                                                         # platform on http://127.0.0.1:4310 (runs module sync first)
pnpm sandbox                                                     # sandbox launcher (packages/sandbox)
```

## Rules that bite first

- `coreloom.json` `modules.enabled`, `platform/package.json` dependencies and `platform/src/generated/**` are CLI-owned; never edit them by hand.
- Tenant id only from `principalFromContext(octane)!.tenantId`; every mutation starts with `sessionMutationDenial(octane, auth)`.
- Declare every imported package in the module `package.json`; relative imports carry `.ts` or `.tsrx`.
- No em or en dashes in code comments, commits, or prose.
