# ADR 0005: Sandbox runtime, coding agents, and sandbox access

- Status: accepted
- Date: 2026-08-31

## Context

Part 2 of the architecture describes an agentic sandbox that builds one module in isolation and previews it without booting the complete platform. Three questions were left open: how the sandbox is distributed, which agent writes the module source, and how a person is authorized to use it.

The platform already ships `agents.core` and `@flowdular/harness`. That runtime is a shared in-product capability: business modules use it to run bounded agents against registered API and CLI tools. It is deliberately not a coding agent. It cannot open a workspace, edit source files, or run gates, and it must not gain those powers.

## Decision

### Distribution and runtime modes

The sandbox is an independently executable package, `@flowdular/sandbox`, with a `flowdular-sandbox` binary. It is started from a Flowdular workspace and discovers that workspace by walking up to `flowdular.json`. Its first-class launch path is `npx @flowdular/sandbox`.

It runs in one of two modes.

- `loopback`: the default for a developer machine. It binds a loopback interface only and may offer locally installed coding agent binaries.
- `self-hosted`: a deployed sandbox. It binds a configured interface, requires the same session and grant checks, and never offers local binaries. Bring-your-own-key providers are the only coding agent backends.

The mode is explicit configuration, not inference. A sandbox that cannot prove it is loopback treats itself as self-hosted.

### Coding agent adapter

Coding agents are a separate contract in `@flowdular/coding-agent`. A driver receives a session workspace, a bounded instruction, and a turn input, and returns an ordered stream of normalized events: assistant text, reasoning summary, tool activity, file change, error, and turn completion with usage.

Three drivers are bundled.

- `claude-code`: the locally installed `claude` binary in print mode with a streamed JSON protocol, restricted tools, and the session workspace as its only writable directory. It uses the operator's existing subscription login. Loopback only.
- `codex`: the locally installed `codex` binary in `exec` mode with JSONL events and a workspace-write sandbox. Loopback only.
- `byok`: the Vercel AI SDK with Anthropic, OpenAI, Azure OpenAI, and OpenAI-compatible kinds, driving the sandbox's own bounded file and gate tools. Available in both modes and required in `self-hosted`.

A driver is offered only after a capability probe succeeds. Local drivers are probed by executing the binary's version command; the byok driver is probed by an existing credential. The driver is chosen when the session is created, next to the brief, and is recorded in the session's audit trail. Roles are never chosen by hand at that point: the planner picks the first specialist and the handoff decides every later one.

The two agent systems stay separate. The sandbox never uses `@flowdular/harness` to write code, and `agents.core` never gains file system or process tools. A draft module that uses `agents.core` is previewed through the normal module contract.

### Turn handoff

A turn ends with a decision about who continues, never with silence. Each role closes its final message with one handoff line naming the next specialist or `none`. The orchestrator validates that line against the registered roles and falls back to the deterministic state routing when it is missing or unknown, so a driver that ignores the instruction still produces a usable next step.

The resulting plan is durable, written into the transcript with the turn that produced it, and has five shapes: `continue` (a specialist takes over with a prompt carrying the original brief), `approval` (a new module's draft specification waits for the operator, who approves it with one click that moves only the `status` line), `question` (the turn changed nothing and needs an answer), `review` (the work is ready to inspect and eject), and `blocked` (the driver errored).

A `continue` runs by itself while the session's auto handoff is on, bounded to a small number of chained turns per operator message, and otherwise waits behind a button. A failed gate is its own handoff back to the specialist that caused it, so a broken change never travels down the chain.

### Preview and data

A session owns an isolated workspace directory and an ephemeral database. The sandbox composes the draft module's server routes at their declared paths and renders its client contribution inside a preview host that supplies the platform's identity, tenant, locale, and ACL contracts.

Preview data has two modes. `fixtures` is the default and is fully offline. `bridge` forwards any API path the draft does not own to a running full platform, using a server-held session for the signed-in account, so a draft screen can read real records from other enabled modules under the platform's own authorization. The bridge is refused when the session lacks the data scope, when the target origin is not configured, or when the sandbox runs without an authenticated principal.

### Access

`sandbox.core` is a normal module of the full platform. It owns sandbox scopes, tenant-scoped access grants, session metadata, and its audit evidence. Access is created and assigned either from the full application, by an owner with the management scope, or from the CLI with `flowdular sandbox` commands. Both paths write the same grant records.

Signing in to the sandbox requires an active `auth.core` account, the `sandbox.access.use` scope on the selected tenant membership, and a grant that is neither revoked nor expired. The sandbox issues its own cookie and never accepts the platform cookie as a sandbox session.

Ejecting a draft into `modules/` is a separate scope and a separate CLI capability with a dry run by default. Eject never writes the platform composition by hand: it copies the module, validates it, and calls the existing `module enable` capability.

## Amendments

- 2026-09-01: A session workspace is a pnpm workspace of its own. Draft
  modules are its projects, every other workspace package is linked to the live
  checkout through `overrides`, the host lockfile seeds the resolution, and
  gates run with the module's own installed binaries. A session may carry
  several modules (`modules[]` in the record, primary first); they are
  materialized, diffed, gated, previewed and delivered together.
- 2026-09-01: Turns are detached from the request that starts them and
  automatic handoffs are chained server-side (limit four per operator message).
  A declared handoff is honoured only when it names a role the finishing role
  may hand to.
- 2026-09-01: Delivery is a target behind `DeliveryTarget`
  (`available`, `plan`, `apply`); the `workspace` target hard-fails on any step,
  removes files an edit deleted, and records the eject on the platform. A
  pull-request target is the next implementation of the same interface.
- 2026-09-01: The sandbox API requires same-origin plus a custom header on every
  mutation, validates session ids as UUIDs, authenticates the state,
  configuration and preview routes, never accepts a mode change over HTTP, and
  reads capabilities from the acting principal. Sessions can be archived,
  restored and deleted, from the sandbox and from `flowdular sandbox` commands.
