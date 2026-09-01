# Examples

Small, deliberately isolated files that show a shape. None of them is compiled or tested; `modules/catalog` is the compiled reference for a module and `modules/auth/src/cli` for a CLI extension.

- `client-contribution/`: `createClientContribution(context)` entry, contribution factory with `csrfToken` threading, an `ICON_PATHS` glyph, unique ids, a `WORKSPACE_SLOTS` widget.
- `customer-cli-extension/`: `commands.json` catalog plus `defineCliExtension` implementation, metadata-identical.
- `bad/`: three negative examples, each with a README naming the violated `AGENTS.md` rule and the repair blueprint: `missing-acl` (raw route without access), `tenant-from-body` (tenant id from input, no session denial), `client-imports-server` (browser code importing the SQLite repository).
- `module-create/task-packet.json`: the task packet shape validated by `validateTaskPacket` in `packages/harness/src/task-packet.ts`. No runtime consumes packets today; the sandbox works from briefs and role turns.
