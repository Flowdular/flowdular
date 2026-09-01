# Skills

Coreloom is an agentic foundation framework: the platform is the foundation, and these skills are how a coding agent (a sandbox specialist or your own tool) builds on it correctly. Each `SKILL.md` is a procedure plus pitfalls, verified against the code it cites, with front matter `name` (equals the directory), `description`, `roles` (who reads it) and `when` (one line).

| Skill                  | One line                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `module-new`           | Create a module from an approved spec: scaffold, what the scaffold lacks, server and client file sets, enable, grant. |
| `module-update`        | Change an existing module with a fixed touch list per change class and the version bump rules.                        |
| `core-extend`          | Change a platform package without breaking modules, generated files, or the copies sandbox sessions read.             |
| `bug-hunt`             | Reproduce with the gate runner, map the symptom to its layer, fix there with a failing test, hunt siblings.           |
| `perf-audit`           | Hot paths of server, client, bundle and agent runtime; measure before changing anything.                              |
| `ux-design`            | The record-screen recipe, five states, component and class inventory, icon keys, copy rules.                          |
| `auth-security-review` | Endpoint threat surface, scope model, API tokens, secrets, greps, destructive CLI rules, required tests.              |
| `test-hardening`       | Where tests run, the route recipe, in-memory repositories, required cases, break-the-implementation check.            |
| `migration-authoring`  | Idempotent schema constants run on repository construction, mirrored SQL files, the guarded ALTER pattern.            |
| `translations-i18n`    | Translations are declared and never loaded; keep files consistent; what a real runtime would touch.                   |
| `cli-extension`        | Module CLI commands through `commands.json` and `defineCliExtension`, with the runner's approval rules.               |
| `agent-tool-design`    | Tools against the real harness contract, the missing registration hook, and the core change that adds it.             |
| `release-eject-pr`     | Sandbox eject sequence, repository gates, branch and PR conventions, post-merge scope grant.                          |

Where they are read:

- Sandbox: the sandbox copies `.ai/skills/**` into each session's `reference/skills/` and the role prompts (`.ai/agents/sandbox/*.md`) say which one to read before the first edit.
- Claude Code: `.claude/skills` is a symlink to `.ai/skills`, so each skill is available as `/module-new`, `/bug-hunt`, and so on; `CLAUDE.md` lists when to load which.
- Codex and other tools: they read `AGENTS.md`, which points here; open the skill file directly.

Adding a skill: create `.ai/skills/<kebab-name>/SKILL.md` with the four front matter keys, keep it between 80 and 200 lines, cite the file that proves each claim, add a row above, and run `npx prettier --check .ai`.
