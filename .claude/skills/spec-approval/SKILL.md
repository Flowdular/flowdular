---
name: spec-approval
description: >-
  Apply an explicit user approval to the exact current Flowdular module
  specification. Use only when the user directly asks to approve one or more
  named current specs, never to infer or initiate approval.
---
# Approve a module specification

Approval is a user decision that an agent may record only as a mechanical
delegate. Never decide that a specification is good enough, treat a review
verdict as approval, or infer approval from requests such as "continue", "looks
good", or "build it".

## 1. Required authority

Proceed only when the current user message explicitly approves:

- one named module;
- the clearly active module referred to as "this module"; or
- every current module in one named sandbox session.

The instruction must refer to the current specification. An approval copied from
an earlier conversation, a different hash, or an earlier session is not
authority for changed content.

If the target is ambiguous, ask which module. If the user approves several
modules, process and report each separately.

## 2. Review the exact input

Before recording approval:

1. Read the entire spec/module.yaml.
2. Confirm its module id and current specVersion.
3. Run pnpm flowdular spec validate --all --json.
4. Check the current diff or sandbox review for the requirements, permissions,
   data ownership and acceptance scenarios being approved.
5. Stop if validation fails, the module cannot be resolved, or the spec changed
   while it was being reviewed.

Do not rewrite requirements while applying approval. A requested content change
is a new spec-authoring step and needs approval after that edit.

## 3. Sandbox path

In the sandbox, use the operator approval action for the selected session module.
The live route is POST /sandbox/api/sessions/:id/approve, exposed by
approveSpecification in packages/sandbox/src/client/api.ts.

The route changes the status presentation and records the SHA-256 hash of the
exact approved text in the session. Do not patch the session workspace file to
bypass that route. Do not forge browser cookies or sandbox request headers. If
the operator route is unavailable, report the blocker and leave the spec
unapproved.

A multi-module session requires an approval record for every affected module.
Approving one module does not unblock another.

## 4. Repository checkout path

Outside the sandbox, after the explicit current user instruction:

1. Change only the top-level status value to approved.
2. Format the file without changing its requirements.
3. Run pnpm flowdular spec validate --all --json again.
4. Compute shasum -a 256 modules/<dir>/spec/module.yaml.
5. Report the module id, version and exact approved hash.

Do not combine approval with implementation changes in the same edit. Once the
approved state and hash are reported, implementation follows module-new or
module-update.

## 5. Staleness

Approval applies only to the exact content that was approved.

- In a sandbox session, the recorded hash is authoritative. Any later edit,
  request for changes, or added module reopens the approval gate.
- In a checkout, any later requirement change must return the status to draft
  or in-review before authoring continues, then receive a new explicit user
  approval.
- A version bump alone is still a content change and needs fresh approval.
- Never copy an approved status line into another module or session.

## 6. Refuse

Refuse to approve when:

- no current user instruction explicitly grants approval;
- the user asked only for review, implementation or continuation;
- validation fails;
- unresolved business questions remain in the spec;
- the target module or session is ambiguous;
- the content changed after the user's decision;
- a sandbox role attempts to approve its own output.

A sandbox business manager may request approval in its handoff. That request is
not approval and cannot satisfy this skill's authority requirement.

## 7. Handoff

After approval, state exactly what was approved and which hash now represents
it. Do not claim that implementation or delivery also passed. Continue to
implementation only when the user's request includes it and the matching skill
allows it.
