# Sandbox work dashboard

The standalone sandbox home groups work by idea, with search, stage filters,
recorded AI usage and a per-session breakdown by specialist. Creating an idea
opens a drawer. The session summary also offers archive, reject, restore and
delete actions. Rejection preserves the working copy; deletion keeps the
transcript and accounting evidence by default.

## Delivery settings

Open **Delivery settings** from the dashboard to configure GitHub review
requests. The drawer uses project defaults unless local overrides are selected.
Repository, delivery mode and reviewers are shown first; remote, base branch,
branch prefix and fork owner are under advanced settings. Saving changes only
the sandbox configuration. Creating a PR remains a separate delivery action and
never implies merging it.

A blank token field preserves the encrypted credential. Removing it requires
the explicit checkbox. Switching to project defaults preserves hidden local
values so they are not silently erased. These are sandbox-wide settings, not
per-account credentials.

## Ownership

New sessions record the connected platform URL, tenant id and account id from
the authenticated operator, never from the request body. The state endpoint
filters sessions before reading their transcripts. Session API reads, mutations,
turn streams and preview API requests enforce the same ownership check.
Platform registration, background state updates and the preview data bridge use
the acting operator's client in self-hosted mode.

Historical sessions without an owner remain visible only in loopback mode and
are excluded from personal totals. Logging in never claims another person's
history. These are local workspace records, not a cross-device billing ledger.
The Vite development server and its source-file serving are not a hardened
multi-tenant hosting boundary; API ownership checks alone do not make shared
hosting safe for mutually untrusted users.

## Usage and costs

The dashboard projects `turn.completed` events from the retained transcript,
including planner events recorded when the session is created. It counts input,
output and total tokens as reported by the driver and groups them by role.
Duplicate sequence ids are ignored. Streaming reads avoid loading prompts and
tool output for every session into one in-memory transcript or API response.

A started turn without a completion, or an aborted/error completion with only
synthetic zero usage, is incomplete. Unknown costs are never presented as free
work. `?` means no reported value and `+` marks an incomplete total. USD amounts
are provider-reported amounts, not invoices or subscription charges. No model
pricing is guessed. Failed work with reported usage still counts.

Personal totals include archived and deleted sessions whose transcripts were
retained. Filters affect the list, not totals. Permanently removing a transcript
also removes that local evidence. Planning before a failed session creation,
provider usage that was never emitted, and historical planner calls cannot be
reconstructed from these records.

## Stages

- Draft: work not yet approved, including partially approved multi-module work.
- Awaiting decision: the operator must review the specification.
- Plans accepted: every current module spec matches its recorded approved hash.
- Needs changes: the operator requested a revision.
- Rejected: the operator explicitly chose not to continue the idea; restoring
  it clears that decision and returns it to its underlying stage.
- Sent for review: a recorded Git delivery, not evidence of a merged PR.
- Delivered locally: successful delivery to the local workspace, not proof of
  a production deployment.
- Needs attention, working and archived preserve their distinct meanings.

Changing a specification invalidates its accepted status. A review request is
not automatically marked merged or deployed. Live PR/merge synchronization and
deployment confirmation are not implemented by this dashboard.

## Verification

`packages/sandbox/tests/dashboard.test.ts` covers usage coverage, duplicates,
failed turns, retained deleted history, spec-hash invalidation, delivery stages,
filtering, locale formatting and translation parity. Route tests exercise
account, tenant and platform isolation, owner spoofing, planner accounting and
reject/restore behavior. `scaffold-flow.test.ts` invokes the real checkout CLI
in an isolated workspace and verifies the approval gate, PostgreSQL scaffold,
preserved business translations and idempotent repeated scaffolding.

The browser check uses synthetic data with the real sandbox UI. It does not
invoke a paid model or validate the quality of a model-generated business module.
