<div align="center">

<picture>
	<source
		media="(prefers-color-scheme: dark)"
		srcset="https://raw.githubusercontent.com/flowdular/flowdular/main/docs/assets/flowdular-logo-dark.svg"
	/>
	<img
		src="https://raw.githubusercontent.com/flowdular/flowdular/main/docs/assets/flowdular-logo.svg"
		alt="Flowdular"
		width="320"
	/>
</picture>

### The Flowdular sandbox

Chat a change, watch it build behind the gates, preview it in the real
application, deliver it as code you own.

![Node](https://img.shields.io/badge/Node-%E2%89%A5%2022.22.2-3A6BE0)
![License](https://img.shields.io/badge/license-MIT-141B2E)
![Built with OctaneJS](https://img.shields.io/badge/built%20with-OctaneJS-2557D6)
![Status](https://img.shields.io/badge/status-preview-8290A8)

</div>

The sandbox is the workshop of [Flowdular](https://github.com/flowdular/flowdular),
the agentic foundation framework. It builds a change in an isolated workspace,
drives the coding agent your team already uses inside it, runs the same gates
the platform runs, and shows the result in the real application shell. A
session carries as many modules as the work touches: one turn writes in one
module, and the whole set is previewed and delivered together.

```bash
npx @flowdular/sandbox            # from a Flowdular workspace
npx @flowdular/sandbox --port 4320 --workspace /path/to/workspace
```

The sandbox is published independently and depends on `@flowdular/sdk`. The SDK
does not include this application or the `flowdular-sandbox` launcher. Use a
sandbox release compatible with the application's SDK version; existing SDK
applications do not need their platform dependencies changed just to launch it.

The launcher finds the workspace by walking up to `flowdular.json`, then opens
http://127.0.0.1:4320.

## What it does

- **Turns a brief into a module.** A planner names the modules and the first
  specialist; business, UX, backend, frontend and agentic roles hand off inside
  one session.
- **Runs your coding agent.** Claude Code or Codex CLI on your machine, or a
  key you bring yourself. The sandbox never ships a model of its own.
- **Keeps the work isolated.** Every session gets its own pnpm workspace, its
  own ephemeral databases, and a preview account that never touches your data.
- **Gates every turn.** Spec schema, module schema, dependencies, typecheck,
  tests and format run against the draft before anything can land.
- **Delivers as code.** Eject into `modules/` and enable it, or open a pull
  request with the gate evidence attached.

## Requirements

Node.js 22.22.2 or newer, pnpm 11, a Flowdular workspace (a directory with
`flowdular.json`), and a running Flowdular application to connect to.

## Documentation

- [Flowdular repository](https://github.com/flowdular/flowdular)
- [Architecture blueprint](https://github.com/flowdular/flowdular/blob/main/docs/architecture-blueprint.md)
- [Module contract (AGENTS.md)](https://github.com/flowdular/flowdular/blob/main/AGENTS.md)
- [Design system](https://github.com/flowdular/flowdular/blob/main/docs/design-system.md)

## Connecting

The sandbox is a client of a running Flowdular application. It never opens the
platform database.

1. In the application, open Administration, API tokens, and issue a token with
   `sandbox.access.use` plus the read scopes the preview should see. Add
   `sandbox.preview.data` for live data and `sandbox.modules.eject` for eject.
2. Paste the token and the application address into the sandbox connect screen.

The token is encrypted at rest with a key in `.flowdular/sandbox/secret.key` and
is never returned to the browser. The application may run anywhere: the sandbox
defaults to `http://localhost:4310`, which supports Vite's IPv4 or IPv6 loopback listener, and can also connect to a deployment. For an older application, enable `sandbox.core` with `pnpm flowdular module enable sandbox.core --apply` while the application is stopped, then restart it. If local demo setup reset the database, issue a new API token before reconnecting.

Sign-in is enforced on the platform side: the token authenticates as its
account, and `sandbox.core` must hold an active grant for it.

## Security model

Every request to the sandbox API is checked before it does anything:

- `loopback` mode trusts the machine only. A request must be addressed to the
  loopback name and the port the launcher bound (`Host: 127.0.0.1:4320` or
  `localhost:4320`); a page on another local port cannot drive the sandbox by
  name. State and configuration calls do not require a connection, because they
  are how one gets connected; everything else does.
- `self-hosted` mode requires a browser session: `POST /sandbox/api/connect`
  with an API token sets an `HttpOnly; SameSite=Strict; Secure` cookie that
  expires after 12 hours. Without it, `GET /sandbox/api/state` answers 401 with
  the mode and the application address, and nothing else.
- Every mutation must come from the sandbox page: `Sec-Fetch-Site` (when the
  browser sends it) and `Origin` must match the sandbox host, and the request
  must carry `x-flowdular-sandbox: 1`. A cross-site form post can do neither, so
  it is refused with 403 before any body is read.
- The mode is the launcher's decision (`--mode`, `FD_SANDBOX_MODE`) and is
  never accepted over HTTP. Changing the application address needs the token
  for that application in the same request, so a stored token is never replayed
  to another host.
- Session ids are UUIDs. Anything else in a `:id` segment or the preview cookie
  is refused before a path is built from it, and a delete additionally checks
  that the real path stays inside `.flowdular/sandbox/sessions`.
- Capabilities (`sandbox.modules.eject`, `sandbox.preview.data`) are read from
  the acting principal: the browser session in `self-hosted` mode, the
  configured connection in `loopback` mode.
- The preview API (`/api/*`) carries the same sandbox authentication. The bridge
  never forwards `/api/auth/*` or `/api/sandbox/*`, and the preview's own
  authentication runtime keeps sign-up closed: the only account is the seeded
  preview account.
- Session views expose workspace-relative paths only. The preview loads draft
  sources through `/preview-module/<session>/<module>/...`, which the sandbox
  maps onto the session workspace itself.

## Modes

| Mode          | Binding              | Coding agents                       |
| ------------- | -------------------- | ----------------------------------- |
| `loopback`    | loopback interface   | local `claude` and `codex`, or BYOK |
| `self-hosted` | configured interface | BYOK only                           |

`--mode` selects it, and a non-loopback `--host` forces `self-hosted`. A
sandbox that cannot prove it is loopback never offers a local binary, because a
local binary carries the operator's own login.

## Model settings

Open the workspace menu and choose **AI models · BYOK**. Select a provider,
enter its model ID and API key, and supply an API base URL for OpenAI-compatible
servers or a resource name for Azure. Saving makes BYOK available in the agent
selector. You can make it the default for new sessions; running turns retain
the configuration they started with.

Keys are encrypted in local sandbox configuration and never returned to the
browser. An empty key field preserves the existing key only when the provider
and destination are unchanged. The settings also let you clear the key or
remove BYOK entirely.

Provider conversations are scoped to the current specialist, module, task skill,
write permissions, approved specification and model. A handoff that changes
that scope starts a fresh conversation with the brief and recent messages;
continuing the same scope resumes its existing conversation. Legacy shared
conversations are replaced on the next turn.

For a long CLI conversation, select **Fresh agent context** before sending the
next message. It starts a new CLI conversation with the original brief and
recent sandbox messages, preserving draft files, the approved specification
and the complete sandbox transcript. Earlier tool output is not replayed;
include any older decision that is not recorded in the spec or recent messages.
Claude activity is shown from the start of streamed response blocks, with
completed reasoning and tool events following as they arrive. This does not
reduce provider queue or inference time.

Source-change logs group repeated saves into a short summary such as
`Draft blog (96a64f10) · 4 files changed`. These report file changes, not a
successful build. Use `--verbose` to see individual paths.

## Sessions

The home dashboard lists the operator's ideas, current stages, recorded token
usage and provider-reported costs. A session summary breaks usage down by
specialist and offers archive, reject, restore and delete actions. Unknown
amounts are marked rather than treated as free work. See
[dashboard accounting and limitations](../../docs/sandbox-dashboard.md).

A session owns a directory under `.flowdular/sandbox/sessions/<id>`:

- `workspace/` is a Flowdular workspace and a pnpm workspace of its own: the
  draft modules under `modules/`, the manifests of every other enabled module
  for dependency validation, `reference/` with read-only copies of the platform
  contracts, one complete example module and the skills under
  `.ai/skills`, and the pointer file the coding agent auto-loads (`CLAUDE.md`
  for claude, `AGENTS.md` for codex).
- `base/modules/<directory>` is the pristine copy an edit diffs against, one
  per edited module.
- `chat.jsonl` is the durable transcript, including every agent event.
- `session.json` is the record. Its shape:

```json
{
	"id": "<uuid>",
	"kind": "edit-module",
	"moduleId": "parties.core",
	"moduleSuffix": "parties",
	"modules": [
		{ "id": "parties.core", "directory": "parties", "kind": "edit" },
		{ "id": "catalog.core", "directory": "catalog", "kind": "edit" }
	],
	"title": "...",
	"brief": "...",
	"blueprint": "edit-module@1.0.0",
	"role": "backend-engineer",
	"driver": "codex",
	"model": null,
	"resumeIds": { "codex": "<thread id>" },
	"autoContinue": true,
	"chainDepth": 0,
	"state": "previewing",
	"createdAt": 0,
	"updatedAt": 0,
	"ejectedAt": null,
	"archivedAt": null,
	"registeredWithPlatform": true
}
```

`modules` is the session: every entry is materialized in the workspace, diffed
against its own base, gated, previewed (all server routes and all client
contributions compose together) and delivered in one eject. `modules[0]` is the
primary module and is repeated as `moduleId` and `moduleSuffix`, which stay in
sync with it; the primary never changes after creation, so everything keyed on
it keeps working.

### Modules of a session

The planner names them from the brief. Rules first: every existing module the
brief names by its whole dotted id (`parties.core`) or as `module parties` is a
change to that module, in the order the brief names them, and a `<domain>.core`
id the workspace does not have is a new module. A bare English word never
selects a module, and a file name (`package.json`) is never read as one. The
planner agent may name more than the rules found; it can never turn a known
module into a new one, and it can never drop a module the brief named. The
classification is the first system entry of the transcript.

A session can gain a module afterwards:

```
POST /sandbox/api/sessions/:id/modules   { "moduleId": "catalog.core" }
```

It copies that workspace module into `workspace/modules/<directory>` and
`base/modules/<directory>`, appends it to `modules`, regenerates the workspace
manifests so the new draft is a project of the session's pnpm workspace (and no
longer a `link:` override), re-runs the install when the new `package.json`
changes the dependency signature, records a system entry, and answers with the
refreshed session view. Refusals, each a stable error code: `404
MODULE_NOT_FOUND` for a module this workspace does not have, `409
MODULE_ALREADY_IN_SESSION`, `409 SESSION_RUNNING` while a turn is in flight,
`409 SESSION_ARCHIVED`, and `409 SESSION_DELIVERED`. A checkpoint taken before
the module joined has no snapshot of it, so a rollback to that point leaves the
new module's files alone.

### One turn, one module

The specialist works in a single module per turn, while the session context
lists all of them. The turn body takes an optional `module` (the draft module
directory):

```
POST /sandbox/api/sessions/:id/turn   { "message": "...", "module": "catalog" }
```

Without it, the module the last handoff named decides, and otherwise the
primary. A `module` the session does not carry is refused with
`MODULE_NOT_IN_SESSION`. The active module is what the instruction calls the
target module, its directory is what the role's `allowedPaths` resolve against
(so a turn may write in that module only), and the state routing (specification,
manifest, server, screen) reads that module. The instruction also lists every
module of the session and says which one this turn owns. Each handoff carries
the module it belongs to: a failed gate hands the fix back in the module the
gate ran in, and an automatically continued turn stays there. Transcript entries
carry their module, so the conversation says where each turn worked.

### Dependencies

The session workspace installs for real. `package.json` and
`pnpm-workspace.yaml` are generated at creation: the draft modules are the
workspace projects, every other workspace package (`@flowdular/*`, the other
modules) is an `overrides` entry pointing at the live checkout with `link:`,
the host `pnpm-lock.yaml` seeds the resolution so versions match the platform,
and the host `patches/` travel along. `pnpm install --offline` runs at creation
and again whenever a draft module's `package.json` changes (the fallback is
`--prefer-offline`, which fetches only what the store lacks). Measured on this
machine: an edit session of `parties.core` installs in about 0.5 s with the
seeded lockfile, a fresh new-module session in about 1 s, a re-run with
nothing changed in about 0.2 s. A failed install is reported as a failed
`dependencies` gate with the installer's output.

A draft that depends on another draft of the same session resolves the session
copy, because both are projects of that workspace; a module that is not part of
the session resolves the live checkout.

New module sessions start from a specification. Once it is approved, the
sandbox runs the same `module new` capability the CLI exposes, so the skeleton
is never hand-written, and formats the skeleton with the workspace Prettier
settings right away. Files the business manager already wrote under the module
(translations, for example) step aside for the scaffold and come back over it.

### Lifecycle

A session can be archived, restored, and deleted from its dashboard summary,
or from the platform CLI (`flowdular sandbox session-archive`,
`flowdular sandbox session-delete`, dry run by default). Archived sessions are
hidden until "Show archived" and refuse new turns until restored. Deleting
removes the workspace, the base copy and the preview data; the record and the
transcript stay as a tombstone unless `keepTranscript: false` is passed. Both
actions refuse a session with a running turn unless asked to stop it
(`stop: true`), and both are recorded on the platform as
`sandbox.session.archived`, `sandbox.session.restored`,
`sandbox.session.deleted`.

### Attachments

An operator can paste a screenshot or attach files (concepts, mockups, specs)
to a turn to show what they want changed. Attachments belong to the session:

- The bytes are stored under `.flowdular/sandbox/sessions/<id>/attachments/<attachmentId>-<safeName>`
  and copied into the session workspace at `workspace/reference/attachments/<safeName>`,
  so the coding agent, which may only read inside the workspace, opens them by
  name with its normal file tools.
- `attachmentId` is a UUID. `safeName` is the original filename reduced to
  `[A-Za-z0-9._-]` with no path segments, no `..` and no leading dot, capped at
  128 characters and made unique within the session.
- Limits: at most 10 per session, 5 MB per file, and only these extensions,
  verified by extension plus a magic-byte sniff for the image and pdf/svg
  formats: `png`, `jpg`, `jpeg`, `gif`, `webp`, `md`, `txt`, `json`, `csv`,
  `pdf`, `svg`. Anything else is refused with a stable error code.
- The record carries them as `attachments: [{ id, name, kind: 'image' | 'file',
size, addedAt }]`, backfilled to `[]` for older sessions.

The endpoints, each behind the same `authorize()`, same-origin and
`x-flowdular-sandbox` boundary as every other mutation, and each validating the
session id and attachment id before building a path:

- `POST /sandbox/api/sessions/:id/attachments` with `{ name, contentBase64 }`
  returns the created attachment metadata.
- `POST /sandbox/api/sessions/:id/attachments/:attachmentId/delete` removes one.
- `GET /sandbox/api/sessions/:id/attachments/:attachmentId` serves the bytes
  with the right content type, `Content-Disposition: inline` and
  `Cache-Control: private, no-store`, for the composer thumbnail.

When a turn runs and the session has attachments, the instruction the driver
receives is prefixed with a short note naming them and their kinds and pointing
at `reference/attachments/`; the operator's own message follows it. The user
entry in the transcript records which attachments were included. Both composers
support paste and an attach button and show each file as a chip with a remove
control. The new-session screen holds the files until the session exists: it
creates the session, uploads them to it, and only then starts the first turn, so
that turn's prompt already names them. It refuses a file the sandbox would
refuse (wrong extension, empty, over 5 MB, more than 10) before uploading, and a
failed upload keeps the created session and stops instead of starting a turn
that cannot see the file.

### Checkpoints

Every turn that changes files leaves a restore point, so an operator can roll a
session's workspace back to an earlier state when a coding agent goes wrong
without losing the transcript.

- A snapshot of each draft module tree is copied to
  `.flowdular/sandbox/sessions/<id>/checkpoints/<sequence>/modules/<directory>`,
  excluding `node_modules`; `base/`, `reference/` and attachments are never
  snapshotted. One is taken at session creation as the pristine start
  (`sequence` 0), and one after every turn that produced a diff, keyed by that
  turn's handoff chat entry so the transcript line and its restore point share
  one sequence.
- The record carries them as `checkpoints: [{ sequence, at, label, role }]`,
  oldest first, backfilled to `[]` for older sessions. `label` is a short human
  line (the role that produced it, `the starting point` for the initial one).
- Bounded to the last 24: when a new one exceeds the cap the oldest is pruned,
  directory and all, except the start, which is never dropped.

Restore replaces the draft files, keeps the transcript, and appends a marker:

- `POST /sandbox/api/sessions/:id/checkpoints/restore` with `{ sequence }`,
  behind the same `authorize()`, same-origin and `x-flowdular-sandbox` boundary
  as every other mutation, validating the session id first. The path is distinct
  from `/restore`, which un-archives a session.
- It replaces `workspace/modules/<directory>` with the snapshot (the current
  contents step aside, `node_modules` stays so the install survives), invalidates
  the diff cache, appends a `system` entry (`Restored the workspace to the state
after <label> (turn <sequence>).`), sets the state back to `editing`, and
  returns the refreshed session view.
- Refusals, each a stable error code: `400 INVALID_SESSION_ID` for a hostile id,
  `400 INVALID_INPUT` for an absent or non-integer sequence,
  `400 CHECKPOINT_NOT_FOUND` for a sequence the session has no snapshot for,
  `409 SESSION_RUNNING` while a turn is in flight, `409 SESSION_ARCHIVED` for an
  archived session, and `409 SESSION_DELIVERED` once the session was ejected
  (start a new session to change the module again).

Each agent turn and handoff block that has a matching checkpoint shows a quiet
`Restore to here` affordance with an inline confirm; it is disabled while the
session runs. Restoring reloads the session so the transcript picks up the
marker and the preview refreshes.

## Roles and routing

Every turn is driven by one specialist with its own instruction, writable paths
and gates: business manager, UX designer, frontend engineer, backend engineer,
agentic engineer. They are workspace configuration in `.ai/agents/sandbox` and
can be edited per workspace.

Nobody picks an agent to start. A session begins with one brief, and the
planner classifies it: new module or change, which modules, what to call them,
and which specialist takes the first turn (see "Modules of a session" for the
rules). The classification is the first system entry of the transcript, so a
wrong guess is corrected in the first message.

Later turns route the same way, against the module the turn targets. Its state
decides who works next
(no specification means the business manager, no server means the backend
engineer, no screen means the frontend engineer), and the words of the request
only choose between specialists that are already valid for that state. An
answer to a question goes back to the specialist who asked it. Every routed
turn says who took it and why; the role picker in the composer overrides it for
one turn, and the module picker beside it overrides which module that turn
works in.

The role documents in `.ai/agents/sandbox` are the source of truth; the
bundled defaults in `@flowdular/coding-agent` are regenerated from them with
`pnpm --filter @flowdular/coding-agent sync-roles`, and a test fails when the
two disagree.

The coding agent is chosen when the session starts, next to the brief, and the
composer can change it for a later turn. A session remembers its agent, so a
handed-off turn runs on the same one.

## Handoffs

A turn never ends in silence. Every role closes its final message with one
line, `HANDOFF: <role-id> - <why>` or `HANDOFF: none - <why>` (a display name
or a trailing full stop is forgiven), and the orchestrator turns that into the
next step:

- **continue**: the named specialist takes over with a prompt that carries the
  original brief. The line is honoured only when it names a role the finishing
  role may hand to (its `handoff` list) and never itself; otherwise the state
  routing decides and the transcript says why. With **Auto handoff** on, which
  is the default, the server starts the next turn by itself on the same stream,
  up to four chained turns per operator message (`chainDepth` in the record).
  With it off, the transcript shows a `Continue with <role>` button instead.
- **approval**: every new or edited module stops before implementation until
  the operator approves its current specification. The approval route moves
  the `status` line to `approved` and records the SHA-256 hash of that exact
  text in the session. An `approved` line written by an agent is not authority.
  Editing the specification or requesting changes makes the recorded hash
  stale and opens the approval gate again. In a multi-module session each
  affected module needs its own current approved hash.
- **question**: the turn changed nothing and needs an answer, whatever the
  specification's status. The answer routes back to the specialist who asked.
- **review**: the specialist reports the request satisfied. Run the gates and
  eject when the change looks right. A business manager who updated a
  specification stops at approval; only the approved handoff starts its
  implementer.
- **blocked**: the coding agent errored. Nothing continues on its own.

A failed gate is its own handoff: the specialist that caused it fixes it before
anyone else works, so a broken change never travels down the chain. The fix
prompt carries the gate command and the first 4000 characters of its output;
the transcript keeps the whole output (head and tail of a long one).

## Turn lifetime

A turn runs to completion on the server whatever happens to the browser: the
driver, the gates and the handoff are written to the transcript even when the
tab closed after the first event. The response is a subscription to that turn,
and closing it only unsubscribes; stopping is an explicit action. The session
reports whether a turn is still running (`running` in the session view and
`running` ids in the state), and a browser that reopens it attaches to the live
stream (`GET /sandbox/api/sessions/:id/turn/stream`) until the chain ends.

A new turn on a session that already has one supersedes it, and waits for the
old process to exit before it starts. Coding agents keep one writer per
conversation thread, so resuming a thread whose previous process is still alive
fails; the sandbox removes that race, and both local drivers recover from a
lock they did not cause by continuing on a fresh thread or session with the
conversation replayed.

## Eject

Eject is a delivery with its own screen. It carries every module of the session
in one delivery, and the plan lists them: per module the files that land, how
many are overwritten, how many the session deleted and will be removed, the
packages it adds that the workspace does not have yet, and whether it has to be
enabled in the platform (new modules only). One confirmation applies them all.
The plan also names the gates that run first and whether the connected
application has to restart. Confirming runs it step
by step and reports each step as it happens:

1. every gate, one by one (module gates once per draft module),
2. the copy into `modules/` for every module of the session, then the removal
   of the files an edit deleted,
3. `pnpm install`, which links workspace packages and fetches whatever a module
   newly declares,
4. `module enable` for each new module, through the same capability the CLI
   exposes,
5. `auth sync-scopes` for each module, which grants the scopes the module's
   specification declares to every workspace owner, because a module nobody has
   permission for is installed and invisible,
6. a platform typecheck with the modules in the composition,
7. optionally a full build,
8. a restart note: the connected application loads the new composition and
   runs new migrations only when it starts, so a local `pnpm dev` has to be
   restarted, and a remote application redeployed.

A failing gate stops the delivery before anything is written, and a failing
step stops it there: the session is marked delivered only when every step
passed, and the failure carries the step's output. A delivered session says so
in the session list, with the time it landed, and the platform records
`sandbox.module.ejected` with what landed.

Delivery is a target behind one interface (`DeliveryTarget` in
`src/server/delivery/types.ts`): `available`, `plan`, `apply`. The eject
request names the target (`target: 'workspace' | 'git-pr' | 'official-modules'`, default from
configuration); the plan answer lists `availableTargets` with a reason for each
one that cannot be used here, and the screen offers the choice only when more
than one is usable.

### Contribute to Official Modules (`official-modules`)

Choose **Send to Official Modules** in the eject dialog, then confirm the displayed
repository and source scope. This target accepts one new module with a current
human-approved specification and passing exact-source auto-review. GitHub access
to `Flowdular/official-modules`, git, gh and pnpm are required. The repository must
be accessible to the configured GitHub identity; private repositories remain private.

The host repeats all sandbox gates, clones the registry to a temporary directory,
refuses an existing module ID/directory, copies the reviewed source and runs the
registry's `pnpm verify`. It records source-bound evidence, packages an immutable
release, and opens a PR to `Flowdular/official-modules` against `main`. Contributors
without upstream push rights use a personal fork. Only module source, its review
and release artifact enter the commit. Credentials stay out of package-script
environments, command arguments and PR text. The local application is not enabled
or changed. Existing branches are never overwritten on retry; only an identical
source tree can be reused after an interrupted PR request.

The target is included in default delivery targets. Projects with an explicit
`sandbox.delivery.targets` list must add `official-modules`. Disabling GitHub
in sandbox settings disables this target too. SDK/CLI npm releases must exist for
the clean registry installation; an unavailable dependency stops before any push.

This action submits code for maintainer review. It does not publish the registry,
merge the PR or bypass PostgreSQL CI. Existing registry modules and multi-module
changes use the contributor skills and a manually prepared branch for now.

### As a pull request (`git-pr`)

The same change, committed on a branch and pushed, so review happens in the
repository and nothing in this working tree moves. One pull request carries
every module of the session, which makes it the unit for a change that spans
modules. Available when the workspace is a git work tree with at least one
commit, the configured remote exists, and the base branch can be read. A pull
request is opened when `gh` is signed in or a provider token is sealed in the
sandbox configuration. Without usable GitHub authentication the sandbox still
pushes the branch and returns a compare link. Set
`sandbox.delivery.git.provider` to `none` when that is always the intended
result. The steps:

1. every gate, as above,
2. `git fetch <remote> <base>`, a detached worktree of `<remote>/<base>` under
   `.flowdular/sandbox/worktrees/<session>`, and the branch
   `<prefix>/<module-dir>-<session id prefix>` in it,
3. the copy and the removals into the worktree,
4. `pnpm install --offline` there (`--prefer-offline` when a package is new),
5. `module enable` for each new module, with the worktree as its root,
6. a platform typecheck in the worktree,
7. the guardrail check: `git status` in the worktree may list only
   `modules/<dir>/**` of the session's modules and `pnpm-lock.yaml`. A delivery
   with a new module may also change `flowdular.json`, `platform/package.json`
   and `platform/src/generated/**`;
   the count stays within `sandbox.delivery.maxChangedFiles` (else the
   `.ai/policies/task-budgets.yaml` figure for the session kind); new packages
   stay within `maxNewDependencies`. A violation names the paths and stops
   before anything is committed,
8. a check that an existing local or remote session branch belongs to this
   session, `git add` of the allowed paths, a commit
   `sandbox: add|update <module id>` with the session id and the gate summary,
   `git push -u --force-with-lease`,
9. `gh pr create` with a plain body: what changed, the gate table, the file
   list (added, modified, removed), the specification versions and field diff,
   detected deployment risks, the post-merge
   `pnpm flowdular auth sync-scopes --module <id> --apply`, the session id, and a
   reviewer note when `.ai/policies/path-ownership.yaml` says a cross-owner
   change needs one. A second delivery of the same session updates the branch
   and keeps the open pull request.

The worktree is removed whatever the outcome; the branch is kept on success
and deleted on failure. A newly pushed remote branch is also removed when PR
creation fails, while an earlier branch for the same session is preserved.
`sync-scopes` is not run: it is a runtime action on
the deployment's database, so it is the post-merge step in the body. Git,
GitHub CLI and pnpm receive only an allowlisted process environment. The raw
sealed token is passed only to GitHub CLI as `GH_TOKEN`; Git receives only a
process-local authorization header. Command output and pull request summary
text are redacted before they can reach the browser or GitHub.

The done screen shows the pull request (or compare) link, and
`.flowdular/sandbox/sessions/<id>/delivery.json` keeps the branch and the URL
for the session.

Open **Delivery settings** on the dashboard to configure GitHub delivery for
this sandbox. Project defaults apply unless local overrides are selected.
Repository, reviewers and delivery mode appear first; the source remote,
base branch, branch prefix and fork owner are under **Advanced settings**.
Saving the form does not create, push or merge a pull request. Push modes are:

- `auto` uses direct delivery only after GitHub confirms push permission and
  refuses otherwise,
- `direct` pushes the session branch to the configured repository,
- `fork` uses the configured fork owner or the account returned by GitHub, and
  creates the fork only after the operator confirms the eject.

The sandbox never creates a fork in `auto` mode. Selecting `fork` is the
operator's explicit consent. The repository must ignore `.flowdular/`; delivery
is refused otherwise so the temporary worktree cannot dirty the active
checkout.

The optional token is encrypted in `.flowdular/sandbox/config.json` with the
local sandbox key. The browser receives only its eight-character fingerprint.
Git receives it through process-local configuration, never in a command
argument or remote URL. The repository settings below remain authoritative
until the operator checks **Use custom settings for this sandbox**.
That local override never modifies `flowdular.json` and can be turned
off again from the same form.

Configuration lives in `flowdular.json`, all of it optional (defaults shown):

```json
{
	"sandbox": {
		"delivery": {
			"default": "workspace",
			"targets": ["workspace", "git-pr"],
			"git": {
				"remote": "origin",
				"baseBranch": "main",
				"branchPrefix": "sandbox",
				"provider": "github",
				"reviewers": []
			},
			"maxChangedFiles": 18
		}
	}
}
```

`provider: "none"` pushes the branch without opening a pull request.
`maxChangedFiles` is unset by default, which means the task budget applies.
The block is validated by `packages/contracts/schemas/project.schema.json`
(`pnpm flowdular doctor`) and read at request time.

## Gates

The session's **Check modules** action opens per-module results with a plain
status and expandable diagnostic output. A skipped check is not a success.
Specification approval requires the matching module's readable review; switching
the specification editor to another module disables saving until that document
loads. A failed turn start retains the user's message and releases the composer.

On desktop the preview is a floating card over the right side of the chat
surface, with room reserved for messages and the composer. **Preview** also opens
the full-screen workbench on mobile, including sessions without file changes.

The browser regression in `tests/browser/session-workflow.mjs` exercises the real
UI with synthetic session, model and delivery responses. Start a sandbox against
a disposable workspace, then run:

```bash
node packages/sandbox/tests/browser/session-workflow.mjs http://127.0.0.1:4438
```

It requires Playwright with Chromium available. If Playwright is provided by an
external runtime, set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path.
Screenshots and results are saved in a temporary directory. No paid model calls,
platform mutations or GitHub operations are made by this regression.

Gates are a fixed list run by the sandbox: `spec-schema` and `module-schema`
once per session workspace, `dependencies`, `typecheck`, `tests` and `format`
once per draft module, with the module's own binaries from the session install.
After a turn the module gates run for the modules that hold changes, not for
every module of the session, and every result names the module it ran in. The
`dependencies` gate runs after every turn that changed files, whatever the role
lists. A failing gate is written back into the conversation, with its
command and output, so the next turn can fix it. An agent whose driver has a
shell may run the same commands itself; the sandbox still runs them after the
turn.

## Preview

The preview renders the session's draft modules inside the real application
shell, so a screen looks exactly as it will in production, including the
navigation entry and dashboard widgets each module contributes. Every draft with
a client entry composes into the same shell, so the navigation shows all of
them; the module selector in the preview head opens the preview on one module's
first screen (`/preview/<session>?module=<directory>`), and the same selection
filters the diff.

The preview API is composed, not stubbed. A request from a preview screen is
answered in this order:

1. The draft module's own routes, loaded from `src/platform.ts` in the session
   workspace and reloaded whenever its sources change.
2. The session's own `auth.core` routes, running on an ephemeral database with
   a seeded preview account.
3. The bridge to the connected application, for everything the draft does not
   own.

That gives a draft screen a real principal, its declared scopes, a real CSRF
contract, and a real database of its own, while still reading live records from
other modules. Preview data has two modes: `fixtures` is fully offline, and
`bridge` forwards the leftovers to the connected application with the sandbox
token. The bridge is read only and refuses without the `sandbox.preview.data`
scope.

### Auto-review

At the final completion handoff, a missing or stale `auto-review` result routes the
same specialist to a separate read-only review turn. The report covers correctness,
security, compatibility, lifecycle, tests and UI, with specific evidence. Findings
return to implementation. A passing report is stored by the server outside the
agent workspace and tied to every module file's content. Later edits invalidate it.
With auto-continue disabled, continue the generated review handoff manually.

All eject targets require a current report for every delivered module and passing
schema, dependency, typecheck, test and format checks. Missing or skipped results
block eject; empty test suites fail. Old sessions need a review before delivery.
The report is a model assessment and does not guarantee correctness; executable
checks remain mandatory, and operator spec approval stays separate.
