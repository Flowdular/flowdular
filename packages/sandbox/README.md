# Coreloom sandbox

A chat with a live preview. The sandbox builds one module at a time in an
isolated workspace, drives a coding agent inside it, runs the same gates the
platform runs, and shows the result in the real application shell.

```bash
npx @coreloom/sandbox            # from a Coreloom workspace
npx @coreloom/sandbox --port 4320 --workspace /path/to/workspace
```

The launcher finds the workspace by walking up to `coreloom.json`.

## Connecting

The sandbox is a client of a running Coreloom application. It never opens the
platform database.

1. In the application, open Administration, API tokens, and issue a token with
   `sandbox.access.use` plus the read scopes the preview should see. Add
   `sandbox.preview.data` for live data and `sandbox.modules.eject` for eject.
2. Paste the token and the application address into the sandbox connect screen.

The token is encrypted at rest with a key in `.coreloom/sandbox/secret.key` and
is never returned to the browser. The application may run anywhere: the sandbox
works the same against `http://127.0.0.1:4310` and a deployment.

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
  must carry `x-coreloom-sandbox: 1`. A cross-site form post can do neither, so
  it is refused with 403 before any body is read.
- The mode is the launcher's decision (`--mode`, `CORELOOM_SANDBOX_MODE`) and is
  never accepted over HTTP. Changing the application address needs the token
  for that application in the same request, so a stored token is never replayed
  to another host.
- Session ids are UUIDs. Anything else in a `:id` segment or the preview cookie
  is refused before a path is built from it, and a delete additionally checks
  that the real path stays inside `.coreloom/sandbox/sessions`.
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

## Sessions

A session owns a directory under `.coreloom/sandbox/sessions/<id>`:

- `workspace/` is a Coreloom workspace and a pnpm workspace of its own: the
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

`modules[0]` is the primary module and is repeated as `moduleId` and
`moduleSuffix` for the current screen, which shows one module per session. A
session may still carry several modules: every one is materialized in the
workspace, diffed against its own base, gated, previewed (all server routes and
all client contributions compose together) and delivered in one eject. Role
`allowedPaths` apply relative to each draft module directory.

### Dependencies

The session workspace installs for real. `package.json` and
`pnpm-workspace.yaml` are generated at creation: the draft modules are the
workspace projects, every other workspace package (`@coreloom/*`, the other
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

A session can be archived, restored, and deleted from the session list menu,
or from the platform CLI (`oerp sandbox session-archive`,
`oerp sandbox session-delete`, dry run by default). Archived sessions are
hidden until "Show archived" and refuse new turns until restored. Deleting
removes the workspace, the base copy and the preview data; the record and the
transcript stay as a tombstone unless `keepTranscript: false` is passed. Both
actions refuse a session with a running turn unless asked to stop it
(`stop: true`), and both are recorded on the platform as
`sandbox.session.archived`, `sandbox.session.restored`,
`sandbox.session.deleted`.

## Roles and routing

Every turn is driven by one specialist with its own instruction, writable paths
and gates: business manager, UX designer, frontend engineer, backend engineer,
agentic engineer. They are workspace configuration in `.ai/agents/sandbox` and
can be edited per workspace.

Nobody picks an agent to start. A session begins with one brief, and the
planner classifies it: new module or change, which modules, what to call it,
and which specialist takes the first turn. Rules answer first: a request that
names an existing module by its whole dotted id (`auth.core`) or as
"module auth" is a change to that module, and a bare English word such as
"users" never selects one. The planner agent decides what the rules cannot; it
may name several modules, and it can never turn a known module into a new one.
The classification is the first system entry of the transcript, so a wrong
guess is corrected in the first message.

Later turns route the same way. The state of the module decides who works next
(no specification means the business manager, no server means the backend
engineer, no screen means the frontend engineer), and the words of the request
only choose between specialists that are already valid for that state. An
answer to a question goes back to the specialist who asked it. Every routed
turn says who took it and why, and the role picker in the composer overrides
it for one turn.

The role documents in `.ai/agents/sandbox` are the source of truth; the
bundled defaults in `@coreloom/coding-agent` are regenerated from them with
`pnpm --filter @coreloom/coding-agent sync-roles`, and a test fails when the
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
- **approval**: a new module whose specification is still a draft stops here.
  The operator approves it in one click, which moves the `status` line to
  `approved` and starts the implementer. Nothing else in the document is
  touched.
- **question**: the turn changed nothing and needs an answer, whatever the
  specification's status. The answer routes back to the specialist who asked.
- **review**: the specialist reports the request satisfied. Run the gates and
  eject when the change looks right. In a change session a business manager
  who updated the specification hands on to the implementer instead.
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

Eject is a delivery with its own screen. The plan names every file that lands,
what gets overwritten, what the session deleted and will be removed, the gates
that run first, any package a module adds that the workspace does not have yet,
and whether the connected application has to restart. Confirming runs it step
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
request names the target (`target: 'workspace' | 'git-pr'`, default from
configuration); the plan answer lists `availableTargets` with a reason for each
one that cannot be used here, and the screen offers the choice only when more
than one is usable.

### As a pull request (`git-pr`)

The same change, committed on a branch and pushed, so review happens in the
repository and nothing in this working tree moves. One pull request carries
every module of the session, which makes it the unit for a change that spans
modules. Available when the workspace is a git work tree with at least one
commit and the configured remote exists; a pull request is opened when `gh` is
signed in (or a provider token is sealed in the sandbox configuration),
otherwise the branch is pushed and the compare link shown. The steps:

1. every gate, as above,
2. `git fetch <remote> <base>`, a detached worktree of `<remote>/<base>` under
   `.coreloom/sandbox/worktrees/<session>`, and the branch
   `<prefix>/<module-dir>-<session id prefix>` in it,
3. the copy and the removals into the worktree,
4. `pnpm install --offline` there (`--prefer-offline` when a package is new),
5. `module enable` for each new module, with the worktree as its root,
6. a platform typecheck in the worktree,
7. the guardrail check: `git status` in the worktree may list only
   `modules/<dir>/**` of the session's modules, `coreloom.json`,
   `platform/package.json`, `platform/src/generated/**` and `pnpm-lock.yaml`;
   the count stays within `sandbox.delivery.maxChangedFiles` (else the
   `.ai/policies/task-budgets.yaml` figure for the session kind); new packages
   stay within `maxNewDependencies`. A violation names the paths and stops
   before anything is committed,
8. `git add` of the allowed paths, a commit `sandbox: add|update <module id>`
   with the session id and the gate summary, `git push -u --force-with-lease`,
9. `gh pr create` with a plain body: what changed, the gate table, the file
   list (added, modified, removed), the post-merge
   `pnpm oerp auth sync-scopes --module <id> --apply`, the session id, and a
   reviewer note when `.ai/policies/path-ownership.yaml` says a cross-owner
   change needs one. A second delivery of the same session updates the branch
   and keeps the open pull request.

The worktree is removed whatever the outcome; the branch is kept on success
and deleted on failure. `sync-scopes` is not run: it is a runtime action on
the deployment's database, so it is the post-merge step in the body. git and
gh run with an environment stripped of `*_TOKEN`, `*_SECRET`, `*_PASSWORD`
and `OERP_*_KEY` variables; `GH_*` and `GIT_*` stay.

The done screen shows the pull request (or compare) link, and
`.coreloom/sandbox/sessions/<id>/delivery.json` keeps the branch and the URL
for the session.

Configuration lives in `coreloom.json`, all of it optional (defaults shown):

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
(`pnpm oerp doctor`) and read at request time.

## Gates

Gates are a fixed list run by the sandbox: `spec-schema` and `module-schema`
once per session workspace, `dependencies`, `typecheck`, `tests` and `format`
once per draft module, with the module's own binaries from the session install.
The `dependencies` gate runs after every turn that changed files, whatever the
role lists. A failing gate is written back into the conversation, with its
command and output, so the next turn can fix it. An agent whose driver has a
shell may run the same commands itself; the sandbox still runs them after the
turn.

## Preview

The preview renders the draft module inside the real application shell, so a
screen looks exactly as it will in production, including the navigation entry
and dashboard widgets it contributes.

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
