# Sandbox

The sandbox is a separate, chat-first application that builds a change in an
isolated workspace, drives the coding agent your team already uses, runs the
same gates the platform runs, and previews the result inside the real
application shell. A session carries as many modules as the work touches.

Full documentation lives with the package:
[packages/sandbox/README.md](../packages/sandbox/README.md).

## Start it

```bash
pnpm sandbox            # from this repository
npx @flowdular/sandbox   # from any Flowdular workspace
```

The launcher walks up to `flowdular.json` to find the workspace and opens
`http://127.0.0.1:4320`. `--port`, `--workspace`, `--host` and `--mode` override
the defaults.

## Connect it to a running application

The sandbox is a client of a running Flowdular application and never opens the
platform database. The preview gets its own embedded PostgreSQL under the
session data directory, with the same roles and the same forced row-level
security a deployment has, and it is thrown away with the session.

1. In the application, open Administration, API tokens, and issue a token with
   `sandbox.access.use` plus the read scopes the preview should see. Add
   `sandbox.preview.data` for live data and `sandbox.modules.eject` for eject.
2. Grant sandbox access to the account, in the app under Development, Sandbox,
   or from the CLI:

```bash
pnpm flowdular sandbox grant --email admin@example.com --tenant operations-demo --apply
pnpm flowdular sandbox access --tenant operations-demo
```

3. Paste the token and the application address into the sandbox connect screen.

The token is encrypted at rest under `.flowdular/sandbox/secret.key` and is never
returned to the browser. The application may run anywhere: locally on
`http://127.0.0.1:4310` or a deployment.

## Modes

| Mode          | Binding              | Coding agents                       |
| ------------- | -------------------- | ----------------------------------- |
| `loopback`    | loopback interface   | local `claude` and `codex`, or BYOK |
| `self-hosted` | configured interface | bring your own key only             |

A non-loopback `--host` forces `self-hosted`. A sandbox that cannot prove it is
loopback never offers a local binary, because a local binary carries the
operator's own login.

## How a session works

A planner names the modules the brief touches and the first specialist role.
Business, UX, backend, frontend and agentic roles hand off inside one session;
each turn writes only in its own allowed paths and is followed by the gates that
role declares. The roles live in [`.ai/agents/sandbox`](../.ai/agents/sandbox),
so a workspace can change them.

When the work is done, eject it into `modules/` and enable it, or open a pull
request with the gate evidence attached.

## Sample data and recorded adapters

A session can carry a sample of the data the module will really see: attach a
CSV, JSON or plain text file (`.csv`, `.json`, `.txt`) to the brief or the
composer, within the attachment limits (5 MB per file, 10 per session). The file
stays in the session directory, is never sent to the connected application, and
is deleted with the session.

Every turn reads the sample through the read-only sandbox tool `sample-data`.
Without input it lists each sample file with its columns, row count and a
parsed preview of the first 20 rows; `{ "name": "customers.csv" }` previews one
file. CSV is parsed with quoted fields and a detected `,`, `;` or tab delimiter,
JSON from a top-level array or the first array inside an object, text as lines.
A value is cut at 200 characters and a row at 40 columns; one preview stays
under 32 KB and the listing under 64 KB, listing a file that does not fit
without its rows. The BYOK driver offers the tool to the model. The local
`claude` and `codex` drivers have no tool channel, so the same listing is
written to `reference/sample-data.json` for the turn.

The backend engineer derives the module's fixtures from the sample:
`tests/fixtures/*.json` for the tests and `preview/seed.json` for the preview. It
keeps the shape and replaces real names, contacts and identifiers with invented
values, because fixtures ship with the module. The role may write `preview/**`,
`src/preview.ts`, `research-fixtures.json` and `adapters/**`.

### Seeding the preview

When a draft module has both `preview/seed.json` (at most 1 MB) and
`src/preview.ts` exporting `seed`, the preview calls it once the generation has
started:

```ts
export async function seed(context: {
	readonly tenantId: string; // the preview workspace
	readonly accountId: string; // the preview account
	readonly data: unknown; // parsed preview/seed.json
	readonly databases: DatabaseProvider; // the preview's own provider
}): Promise<void>;
```

`seed()` writes through the module's own repository, as the server composition
does. The sandbox keeps a hash of both files in the session data directory and
calls `seed()` again only when one of them changes, so it must be idempotent
(upsert by the natural key). A failure is reported as the preview error of that
module and never stops the preview. The preview does not seed through an
`import.ports.v1` port: only `import.core` can read its port registry (the
public capability registers ports), a port write needs a full principal and a
job, and most drafts do not compose `import.core`.

### Recorded adapters

A draft spec with a `research` section previews through `research.core`. The
preview composes it from the platform modules ahead of the drafts and holds
`research.core.adapter` at `recorded` and `research.core.recordedFixturesPath`
at the absolute path of the module's `research-fixtures.json` for every
workspace; changing either answers `409 SANDBOX_LIVE_ADAPTER_REFUSED`. When
several drafts declare research, the first one in session order supplies the
path. An entry of the spec's `adapters` section reads the fixture its `recorded`
field names, by convention `adapters/<id>.recorded.json`.

A session declares only recorded adapters; an owner connects a live search or
connector instance after delivery. When a draft spec sets `research.adapter` to
`model-native` or `connector`, or lists an adapter without `recorded`, the
`spec-schema` gate fails with `SANDBOX_LIVE_ADAPTER_REFUSED` and names the file
and field, so the turn goes back to its specialist and delivery stops. The
preview refuses to compose such a session with the same code before a worker
starts. A `research` section without `adapter` is previewed on the recorded
fixtures.

## Deliver as a pull request

The eject route (`POST /sandbox/api/sessions/:id/eject`) takes `target:
'workspace' | 'git-pr'`. `workspace` copies the session modules into `modules/`
of this checkout. `git-pr` (`packages/sandbox/src/server/delivery/git-pr.ts`)
commits the same change on a branch and opens a pull request; the operator's
working tree and index stay untouched because the work happens in a detached
worktree under `.flowdular/sandbox/worktrees/<session id>`, removed afterwards.

### Configuration

Project settings live in `flowdular.json` under `sandbox.delivery`, read at
request time (`delivery/configuration.ts`): `targets`, `default`,
`maxChangedFiles` and `git` with `remote`
(`origin`), `repository` (`owner/name`, derived from the remote when null),
`baseBranch` (`main`), `branchPrefix` (`sandbox`), `provider` (`github` or
`none`), `mode` (`auto`, `direct` or `fork`), `forkOwner`, `reviewers` and
`labels` (added to the pull request after creation, default
`sandbox-delivery`; a label the repository lacks never fails a delivery).

Operator settings live in the sandbox configuration
(`.flowdular/sandbox/config.json`, `GitHubDeliveryConfiguration` in
`server/config.ts`) and are set from the sandbox settings screen, not from
environment variables: `enabled`, `overridesProject`, `remote`, `repository`,
`baseBranch`, `branchPrefix`, `mode`, `forkOwner`, `reviewers` (settings
request fields `githubEnabled`, `githubOverridesProject`, `githubRemote` and so
on). With `overridesProject` the operator values replace the project `git`
block except `provider`. `enabled: false` disables the target with
`EJECT_TARGET_DISABLED`. A provider token (`githubToken` in the settings
request, stored sealed as `gitProviderToken`) is handed to `gh` as `GH_TOKEN`
and to `git` as a redacted authorization header; it never appears in command
arguments, remote URLs or step output.

### Branch and pull request

The branch is `<branchPrefix>/<module directory>-<first 8 characters of the
session id>`, created from `<remote>/<baseBranch>`. In the worktree the sandbox
stages the modules, runs `pnpm install`, `module enable` for each new module and
the platform typecheck, then checks the guardrails: changed paths limited to the
session modules, the lockfile and the CLI-owned composition files, the file
count within `maxChangedFiles` (else `.ai/policies/task-budgets.yaml`), new
packages within `maxNewDependencies` from `.ai/policies/task-budgets.yaml`
(default 0, per-kind overrides). Owners and the cross-owner reviewer
requirement (`crossOwnerChanges.requireReviewer`) come from
`.ai/policies/path-ownership.yaml`. The commit reads
`sandbox: add|update <module id>` with the session id and the gate summary; the
push uses `--force-with-lease`. A branch that exists but was not created for
this session is refused (`GIT_BRANCH_CONFLICT`).

With `provider: github` and a working `gh auth status`, `gh pr create` opens the
pull request against `baseBranch` with `--reviewer` from `reviewers`; when a
pull request for the branch is already open, the push updates it. `mode: auto`
uses a direct push only after GitHub confirms push access and otherwise asks the
operator to choose `direct` or `fork`; only an explicit `fork` creates or reuses
`<forkOwner>/<name>`. Without `gh`, without a login, or with `provider: none`,
the branch is still pushed; the plan shows a GitHub compare link when
`repository` is configured or derived from a GitHub remote URL, otherwise the
remote and branch name.
`.flowdular/sandbox/sessions/<id>/delivery.json` keeps the branch and the URL.

### Gates as evidence

Delivery reruns every gate from `delivery/plan.ts` (`spec-schema`,
`module-schema`, `dependencies`, `typecheck`, `tests`, `format`, `auto-review`)
before anything is committed; a missing, failed or skipped result stops it
(`EJECT_GATES_MISSING`, `EJECT_GATES_FAILED`), and each module needs a current
review record (`EJECT_REVIEW_REQUIRED`) and an approved spec hash. The pull
request body carries the spec version and status per module, a table of gate,
module and result, the files added, modified and removed, the risks the
guardrails noticed, and the post-merge `auth sync-scopes` command. The table is
what the sandbox measured on the delivered bytes; `pnpm verify` on the branch
and a human review remain the repository's own gate.

## Decisions the specialist needs

A specialist that cannot continue without a business decision ends its reply
with one fenced block tagged `questions` holding a single JSON object:

````
```questions
{
	"questions": [
		{
			"id": "Q-1",
			"question": "Who may cancel a booking?",
			"options": ["Only the owner", "Any team member"],
			"recommended": "Only the owner",
			"allowFreeText": true
		}
	]
}
```
````

The sandbox parses it server side and bounds it: at most 12 questions, unique
ids shaped `Q-1`, a question of 1 to 400 characters, at most 8 distinct options
of 1 to 120 characters, and a recommendation that must be one of those options.
`allowFreeText` defaults to false, and a question with neither an option nor
free text cannot be answered, so it is refused. The block has to be the last
thing in the reply apart from the mandatory handoff line, and a reply carries at
most one. A block the sandbox cannot read is a warning on that turn, never a
failed turn: the words of the reply still stand and the transcript says why the
block was ignored.

A readable block is stored on the session as `pendingQuestions`, with the
transcript sequence of the message that asked, the role that asked and the
module it asked about. Records written before the field existed read as `null`.
Every turn rewrites it, so the form only ever shows what the newest specialist
is waiting on.

The session view shows the questions as a list rather than as JSON, and offers a
form below the open handoff: one radio group per question with the
recommendation preselected, a free-text field where the specialist allowed one,
and an optional note. Submitting posts

```
POST /sandbox/api/sessions/:id/answers
{ "answers": [{ "id": "Q-1", "answer": "Only the owner" }], "message": "optional" }
```

behind the same origin, header and ownership checks as every other mutation. It
clears `pendingQuestions` and starts the next turn in the role that asked, in
the module it asked about, with the decisions leading the request text:

```
Decisions:
- Q-1: Who may cancel a booking? -> Only the owner

<the operator's optional message>
```

The response is the turn stream, exactly as `POST /sandbox/api/sessions/:id/turn`
answers. Refusals, each a stable error code: `409 NO_PENDING_QUESTIONS` when
nothing is waiting, `409 SESSION_ARCHIVED`, `409 SESSION_DELIVERED`, and `400
INVALID_INPUT` for a body that leaves a question unanswered, names a question
the session did not ask, exceeds 400 characters, or gives an answer that is not
one of the offered options when the specialist allowed no free text.

## Operator commands

```bash
pnpm flowdular sandbox sessions --tenant <tenant>
pnpm flowdular sandbox session-archive --tenant <tenant> --id <session-id> --apply
pnpm flowdular sandbox session-delete --tenant <tenant> --id <session-id> --apply
pnpm flowdular sandbox revoke --email <email> --tenant <tenant> --apply
pnpm flowdular sandbox audit-verify --tenant <tenant>
```
