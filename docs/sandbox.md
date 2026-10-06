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
npx @flowdular/sandbox   # from any Flowdular workspace, or from an empty one
```

In an empty directory, the command creates a standalone Flowdular application,
installs its dependencies, starts it with a local embedded PostgreSQL database,
prepares the sandbox credential and serves the dashboard on
`http://127.0.0.1:4320`. You can then describe the module in the dashboard.

## Start with nothing installed

There is no checkout step.

```bash
mkdir acme-erp && cd acme-erp
npx @flowdular/sandbox
```

The launcher uses `create-flowdular` at the sandbox package's exact version,
installs the generated application and makes its first local Git commit. It
reuses that workspace on later runs. The application lands in `./flowdular`
unless `--workspace <path>` names another directory. No remote is created until
you choose one.

The repository dialog can create a private GitHub repository or connect an
empty one after showing the initial push plan. If creation is interrupted, the
same dialog shows the pending attempt. You can resume it or discard its local
record after GitHub returns an authenticated 404. A private repository hidden
from the current account may also return 404, so check GitHub if creation may
have succeeded.

To work on an existing platform repository, run
`npx @flowdular/sandbox --connect <git-url>` and optionally `--branch <name>`.
The launcher clones into a new directory, checks `flowdular.json` and the
committed pnpm lockfile, then installs dependencies. Run from an existing
Flowdular checkout to reuse it without cloning. `--no-bootstrap` refuses to
create an application. The older `--repository` and pinned `--ref` options
remain available when you deliberately want a checkout of the Flowdular core
repository.

The launcher refuses to create or clone into a directory containing unrelated
files. For application generation, Git and pnpm are checked before files are
written.

An application already serving on the platform port is left alone, and no
credential is prepared for it. `--platform` and `--platform-port` say otherwise
explicitly; `--no-platform` never starts one.

## The credential is prepared, not pasted

A business user used to sign in to the application, create an API token with
three scopes, paste it into the sandbox and grant that account sandbox access
before describing anything. None of those is a business decision, so the
application does them during its own boot when the launcher asks, and the
launcher collects the result.

- It runs only when the launcher started the application, so an application
  someone else owns is never asked to create an account.
- It reuses an existing workspace and account rather than replacing them, and
  mints exactly one token for the life of the deployment.
- The token carries the four sandbox scopes and nothing else.
- It is written to a `0600` file that the launcher seals into its own
  configuration and deletes. It is never printed, so it reaches no terminal, log
  or transcript.
- Token management over HTTP is unchanged: `POST /api/auth/api-tokens` still
  refuses a machine credential, and no route was added for this.

The account is `sandbox-operator@example.com` in a `sandbox` workspace, with a
password nobody has. It exists to hold the grant.

**A failed provision never stops the application.** It is a convenience for a
local operator, and an application that will not serve because a sandbox account
could not be created is worse than one that serves and reports the problem.

For a remote deployment, or a sandbox started some other way, the dashboard says
what is missing. One command fixes it:

```bash
pnpm flowdular sandbox provision --apply
```

## Connect it to a running application

The sandbox is a client of a running Flowdular application and never opens the
platform database. The preview gets its own embedded PostgreSQL under the
session data directory, with the same roles and the same forced row-level
security a deployment has, and it is thrown away with the session.

1. In the application, open Administration, API tokens, and issue a token with
   `sandbox.access.use` plus the read scopes the preview should see. Add
   `sandbox.preview.data` for live data and `sandbox.modules.eject` for eject.
   Enable token writes so the sandbox can record sessions, eject modules and
   publish the application repository when you request it.
2. Grant sandbox access to the account, in the app under Development, Sandbox,
   or from the CLI:

```bash
pnpm flowdular sandbox grant --email admin@example.com --tenant operations-demo --apply
pnpm flowdular sandbox access --tenant operations-demo
```

3. Paste the token and the application address into the sandbox connect screen.
   The same screen asks for a model provider and key, unless the workspace
   already carries one, in which case it names the variable it adopted.

The token and the model key are encrypted at rest under
`.flowdular/sandbox/secret.key` and are never returned to the browser. The application may run anywhere: locally on
`http://127.0.0.1:4310` or a deployment.

## Modes

| Mode          | Binding              | Coding agents                       |
| ------------- | -------------------- | ----------------------------------- |
| `loopback`    | loopback interface   | local `claude` and `codex`, or BYOK |
| `self-hosted` | configured interface | bring your own key only             |

A non-loopback `--host` forces `self-hosted`. A sandbox that cannot prove it is
loopback never offers a local binary, because a local binary carries the
operator's own login.

The bring-your-own-key driver takes its credential from the sandbox model
settings, or, when none is saved there, from `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `AZURE_API_KEY` or `AI_GATEWAY_API_KEY` in the environment or
the workspace `.env`. A scaffolded application ships the first of those as an
empty placeholder, so pasting a key is the whole setup.

## Typed decisions

The brief classification the planner performs (which module, spans several,
which specialist starts) can be answered by a decision provider instead of a
coding-agent turn. It is off by default, turned on per sandbox with
`decisionsEnabled` through `POST /sandbox/api/config`, and takes its credential
from the sandbox configuration or `TYPESAFE_API_KEY` in the environment or the
workspace `.env`. Answers below their confidence thresholds, a brief that spans
modules, and any provider failure all fall back to the workspace rules and the
planner turn. Implementation writing stays with the coding agent: a decision
provider generates no text and drives no tools. See
[`packages/sandbox/README.md`](../packages/sandbox/README.md) for the settings.

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
`research.core.adapter` at `recorded`, the adapter chain at the recorded adapter
alone (`searchOrder` at `recorded` with `recordedEnabled` on, `fetchOrder` at
`direct`) and `research.core.recordedFixturesPath` at the absolute path of the
module's `research-fixtures.json` for every workspace. A chain holding the
recorded adapter reads pages from the same file before it looks at the fetch
order, so nothing reaches the network. Changing any of them answers
`409 SANDBOX_LIVE_ADAPTER_REFUSED`. When several drafts declare research, the
first one in session order supplies the path. An entry of the spec's `adapters`
section reads the fixture its `recorded` field names, by convention
`adapters/<id>.recorded.json`.

A session declares only recorded adapters; an owner connects a live search or
connector instance after delivery. When a draft spec sets `research.adapter` to
`model-native`, `searxng`, `firecrawl` or `connector`, or lists an adapter
without `recorded`, the `spec-schema` gate fails with
`SANDBOX_LIVE_ADAPTER_REFUSED` and names the file and field, so the turn goes
back to its specialist and delivery stops. The preview refuses to compose such a
session with the same code before a worker starts. A `research` section without
`adapter` is previewed on the recorded fixtures.

## Deliver as a pull request

The eject route (`POST /sandbox/api/sessions/:id/eject`) takes `target:
'workspace' | 'git-pr'`. `workspace` copies the session modules into `modules/`
of this checkout. `git-pr` (`packages/sandbox/src/server/delivery/git-pr.ts`)
commits the same change on a branch and opens a pull request; the operator's
working tree and index stay untouched because the work happens in a detached
worktree under `.flowdular/sandbox/worktrees/<session id>`, removed afterwards.

For an application generated by the sandbox, open **GitHub settings** and then
**Set up repository**. Choose an existing empty GitHub repository or
create a new private one. The sandbox shows the repository, local commit and
target branch for review before the operator confirms the first push. It then
adds a local `app` remote, pushes `main` without rewriting remote history and
configures GitHub delivery to use that remote. A repository that already has
commits should be opened with `--connect` when launching the sandbox. GitHub
CLI authentication or a token saved in GitHub settings is needed for creating
and pushing; the setup action also requires `sandbox.modules.eject`.

After the module specification is approved and the gates pass, choose the
`git-pr` delivery target to push a branch and open its review. The sandbox does
not approve a specification or push module code merely because a repository
was connected.

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
most one. A block the sandbox cannot read is never a failed turn and never
dropped in silence: the transcript says why it was refused, and the specialist
gets the reason and these limits for one repair turn. A second refusal in a row
stops for the operator, who answers in words. A turn that asks stops for the
answers, never for approval, and the approval route refuses a module with open
questions (`409 QUESTIONS_PENDING`).

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
