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

## Operator commands

```bash
pnpm flowdular sandbox sessions --tenant <tenant>
pnpm flowdular sandbox session-archive --tenant <tenant> --id <session-id> --apply
pnpm flowdular sandbox session-delete --tenant <tenant> --id <session-id> --apply
pnpm flowdular sandbox revoke --email <email> --tenant <tenant> --apply
pnpm flowdular sandbox audit-verify --tenant <tenant>
```
