# Auto-review delivery gate, 2026-09-10

Overall verification is incomplete because checks of the current shared workspace
encounter platform and preview failures. No merge, eject or spec approval was performed.
The workspace already contained extensive edits and was concurrently renamed
from Coreloom to Flowdular. Those edits were preserved.

## Change reviewed

Canonical `auto-review` skill and generated discovery copies; the host completion
rule and reviewer procedure; sandbox skill routing, turn completion, read-only
review, review records, mandatory delivery gates and their regression tests.

Intermediate specialist handoffs remain available. A final completion handoff
checks every session module for a current review and routes missing evidence to
a separate read-only turn. The reviewer receives the original module files under
`reference/auto-review-base/`. The existing path guard restores unauthorized
writes and prevents that turn from recording a pass. A record is saved only after
all required deterministic checks pass and the module hash still matches the
start of review. Findings return to implementation. Both delivery targets require
complete gate results and recheck review evidence before copying sources.

## Evidence

| Requirement                                         | Verification                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing, malformed or unresolved review cannot pass | `tests/auto-review.test.ts` rejects missing records, invalid JSON, incomplete checks and nonempty findings.                                                                                          |
| Content changes invalidate review                   | Tests cover additions, modifications, deletions and module separation. Hashing includes code, tests, specs and configuration.                                                                        |
| Review cannot edit or bypass tests                  | `tests/spec-gate.test.ts` exercises the real turn/path guard, checks the original-file reference, restores attempted writes and rejects a passing model report when tests fail or are skipped.       |
| Team work can continue before final review          | An integration test preserves the backend-to-frontend handoff; terminal completion routes to auto-review.                                                                                            |
| Delivery requires every result                      | Tests reject skipped gates, omitted module results and an empty gate plan. Local and Git delivery fixtures include per-module review records.                                                        |
| Empty suites fail even with a permissive config     | A real Vitest invocation with `passWithNoTests: true` is overridden by the fixed runner argument.                                                                                                    |
| Tests detect the original defects                   | An isolated copy restored acceptance of skipped gates and empty suites. Exactly those two regression tests failed; five other review tests passed. The checkout was not mutated for this experiment. |
| Custom specialists can review                       | Coding-agent routing tests cover the built-in roles and an explicit custom-role review without granting implementation or spec-approval permissions.                                                 |

Scoped validation: 44 coding-agent tests passed after the rename. All 228 sandbox
tests passed before the concurrent rename; the renamed focused delivery/review
suite passed 125 tests, and the final completion-routing adjustment passed 88
scoped tests. The final sandbox run reports 219 passed and 10 failed, all failures
in `tests/preview-worker.test.ts`; all review, handoff and delivery tests pass.
Sandbox typechecking, generated-rule checks and formatting of the changed files
pass. `git diff --check` passes.

Repository-wide `pnpm verify` was attempted repeatedly. The latest attempt stops
at platform typechecking: `@flowdular/kernel/runtime-config` cannot be resolved
in `platform/src/server/database.ts` and setup adapters/token. A preceding run,
during the rename, failed nine isolated-preview-worker tests. `pnpm build`
completed CLI build/smoke but stopped in platform composition because the build
script selected PGlite while production configuration rejected that adapter.
The final preview run reports `Access to this API has been restricted`. Inspection
shows that the concurrently added state-directory resolver calls `lstatSync` on
workspace state roots, while the preview worker grants reads only inside its
session and source/dependency roots. This is a likely cause of the preview failure;
the rename and preview permission work were not changed by this task. These
failures were not waived.

## Review limits

No new public endpoint, identity source, database schema or permission was added.
Review records contain model assessments and are not semantic proof or operator
spec approval. Host auto-review is an instruction requirement, while sandbox
delivery checks are executable requirements. The gate does not claim transactional
isolation against arbitrary external edits during delivery. Hashing and baseline
copying cost O(total module bytes), with file reads processed sequentially; review
adds a full gate run at completion. UI changes only add gate-name translations;
there is no new layout or interaction.
