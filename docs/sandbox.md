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
