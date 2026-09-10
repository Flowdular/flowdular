---
name: auto-review
description: >-
  Review a finished core or module change against its requirements, public
  contracts and executable regression evidence before delivery. Report defects
  with failure scenarios; never approve an unverified change.
roles:
  - module-executor
  - reviewer
  - backend-engineer
  - frontend-engineer
  - ux-designer
  - agentic-engineer
when: Implementation is complete, before final handoff, sandbox eject, or a core PR.
---

# Auto-review

This is a separate review phase after implementation. Read the owning code, the
complete change including additions and deletions, its callers, requirements and
tests. Preserve unrelated edits. Do not load other skills during this phase.
Do not modify production code, tests, specifications or generated files. Findings
return to the implementation phase; every later edit requires another review.
Review is a model assessment, not a guarantee of correctness or spec approval.

## Required checks

For every check, cite the relevant files and concrete evidence. Use a reasoned
not-applicable explanation only after inspecting the change. Generic "looks good"
or "tests pass" is not evidence. A missing check blocks a passing verdict.

1. **Correctness:** map each requested behavior and acceptance scenario to code
   and an observable test. Trace invalid inputs, empty results, boundaries and
   failure paths. Check existing behavior outside the requested change. Find
   sibling call sites and copies that need the same fix.
2. **Security:** trusted principal and tenant identity, explicit permissions,
   denial tests, CSRF for mutations, input bounds, parameterized SQL, tenant
   predicates and forced RLS, secret redaction and cross-module authority.
   Test unauthenticated, denied and cross-tenant requests where applicable.
3. **Compatibility:** exports, signatures, optional fields, errors, dependency
   direction and every consumer affected by the contract. Check manifests,
   declared dependencies, spec/package versions and CLI-generated composition.
   Applied migrations must remain byte-identical; check new migrations, fresh
   apply, adoption and tenant isolation through the actual database provider.
4. **Lifecycle:** concurrency, cancellation, cleanup, bounded memory, resource
   ownership, durable background work, retries, idempotency and recovery. State
   the cost of changed loops or queries; investigate new unbounded work.
5. **Tests:** assertions must observe behavior, not duplicate implementation.
   A regression test must fail with the defect restored and pass with the fix.
   Cover relevant negative and failure cases. No skipped assertions, empty
   suites, mocked-away ownership boundary or weakened existing checks. Record
   actual commands, results and failures, and distinguish tests not yet run.
6. **UI:** when rendered behavior changes, inspect the rendered result, keyboard
   interaction, shared components, translated copy and loading/empty/error/
   populated/denied states. Record the inspected scenario; otherwise explain
   why the diff has no rendered effect.

## Core and host module changes

Review only the requested change while accounting for existing workspace edits.
Run scoped checks first, then `pnpm verify`. For a core change also run `pnpm build`
(the CLI smoke and platform build exercise integration). Do not waive a failing,
missing or skipped required check; list unrelated existing failures separately
and leave verification incomplete. Re-read the final diff after generated output
or formatting changes. Save a concise report with files reviewed, scenario-to-test
mapping, commands/results, unresolved findings and remaining risks. Finish with
pass only when all applicable checks have evidence and no actionable defect
remains. Root instructions require this phase before declaring the work complete;
there is no host-side runtime enforcement of a model's review verdict.

## Sandbox

The orchestrator routes a failed `auto-review` gate to this skill. The turn is
read-only and retains the current role and active module. Inspect the whole module
change relative to `reference/auto-review-base/`, including deleted files, not
just your last edit. Preserve the intended next-specialist handoff from the
implementation turn after a passing review. Use the provided
reference code and recorded gate output. The orchestrator runs schema, dependency,
typecheck, tests and format gates; never claim you ran a command it ran later.
Report verification still pending when needed. Deterministic checks are independent
of your assessment and must all pass before eject.

Return exactly one fenced `auto-review` JSON object in the closing response,
followed by the normal handoff line. Each check is a string of 20 to 4000 characters
with actual evidence or a specific not-applicable explanation. Keep the response
under 32000 characters. The structure is:

```auto-review
{
  "verdict": "fail",
  "checks": {
    "correctness": "Files, acceptance scenarios and observed behavior.",
    "security": "Relevant authorization and tenant denial evidence.",
    "compatibility": "Public consumers and migration or manifest evidence.",
    "lifecycle": "Resource ownership and failure-path evidence.",
    "tests": "Test paths, assertions, actual gate results or pending checks.",
    "ui": "Rendered inspection evidence or a specific reason not applicable."
  },
  "findings": ["Severity; file:line; input/state; wrong outcome; required fix."]
}
```

Use `pass` and an empty findings array only when no actionable defect remains.
Do not copy the example evidence. Include every actionable finding, not taste
preferences. A failing review returns to implementation; never repair files in
this turn. A passing record is written by the orchestrator outside the workspace
and bound to all module file bytes. Subsequent edits invalidate it. Old sessions
without a current report must run auto-review before eject. Eject rejects skipped
and missing gates as well as failures; a test suite with no tests fails.

Owning code: `packages/sandbox/src/server/auto-review.ts`, `turns.ts`, `gates.ts`,
`delivery/steps.ts`, and `packages/coding-agent/src/roles/skills.ts`.
