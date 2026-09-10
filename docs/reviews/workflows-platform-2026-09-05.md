# Workflows and platform review, 2026-09-05

## Scope and status

This review covers the workflow editor and data mappings, workflow execution
smoke tests, sandbox process lifecycle and preview reloads, owner scope
inheritance, PostgreSQL provider readiness and bootstrap, and CLI configuration.
It is not a certification of every screen, node option, integration or deployed
database. The checkout contains concurrent work by other agents.

## Implemented fixes

| Area                   | Confirmed failure and correction                                                                                                                                                                                         | Evidence                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Pointer fields         | Controlled fields lost edits. Draft state now preserves text; the schema-only picker inserts RFC6901 paths, displays types/descriptions and supports keyboard selection.                                                 | `modules/workflows/tests/pointer-model.test.ts`; browser selection, save and simulation                      |
| Available sources      | Sources could include unrelated branches or unused output ports. Choices are restricted to connected upstream paths.                                                                                                     | `pointer-model.test.ts`, `graph-contract.test.ts`                                                            |
| Input forms            | Partial object JSON reverted or left an old value runnable. Local drafts now preserve partial input and block execution until valid. Empty text remains an empty string.                                                 | `input-model.test.ts`; browser typing `{` then completing the object                                         |
| Run actions            | Successful runs offered cancellation; failed simulations and users without execution permission saw retry. Actions now respect mode, status and permission.                                                              | `run-actions.test.ts`                                                                                        |
| Canvas                 | Port measurements used stored node positions during drag; resize callbacks could repeatedly update state. Offsets now use the rendered node and bounded frame scheduling. Inspector close stays visible while scrolling. | Browser inspection; viewport/model tests                                                                     |
| Mapping execution      | Missing root sources, inherited properties, loose boolean gates and unrelated mapping sources were accepted. Runtime and compilation now reject these cases.                                                             | `graph-contract.test.ts`                                                                                     |
| Node execution         | Input validation and merge collection handling differed between simulation and live execution.                                                                                                                           | `node-execution.test.ts`: all eight built-in types, simulation and real worker with fake public capabilities |
| Owner permissions      | Module grants reached current owners but not the owner role or subsequent owners. Grants now update both atomically; membership writes reread the owner role under a transaction lock.                                   | `modules/auth/tests/owner-scope-grants.test.ts`                                                              |
| Generated platform     | The scaffold omitted the required database provider when constructing auth.                                                                                                                                              | Generated configuration smoke test in `packages/create-flowdular/tests`                                      |
| CLI database selection | The executable ignored workspace `.env`, unlike the platform. It now loads it before command execution; actual environment values retain precedence. Unreadable configuration refuses fallback.                          | `packages/cli/tests/program-environment.test.ts`, isolated child processes, no database connections          |
| Provider readiness     | The configured background PostgreSQL role was not checked for connectivity or bypass privileges. Readiness now checks it.                                                                                                | `packages/database/tests/provider.test.ts`                                                                   |
| Sequences              | Platform PGlite and server test bootstrap lacked sequence privileges available in Docker/test PGlite. Future sequences now receive matching default grants.                                                              | `packages/database/tests/provider-security.test.ts`, real in-memory PostgreSQL                               |
| Sandbox turns          | Route reload lost active turns; a stop timeout released workspace ownership while a writer could still be running. Process-level ownership survives HMR and timeout refuses the next operation.                          | Sandbox turn lifecycle regression tests                                                                      |
| Preview                | Imported handler changes stayed in the worker module cache. Source revisions now replace the worker, preserve session keys and await database drain.                                                                     | Preview worker regression tests                                                                              |
| Preview IPC            | A worker disconnect between `connected` and `send` caused uncaught `EPIPE`. Asynchronous send failures are handled.                                                                                                      | Preview IPC tests and sandbox suite                                                                          |

## Unresolved P1: several terminal outputs

The graph below is accepted by the current contract:

```text
Input -> Output first
     \-> Action -> Output last
```

In simulation all four steps finish and `run.output` contains the last output.
Live execution settles the whole run at the first output, never invokes the
action and leaves two nodes pending. The single `run.output` field has no
documented aggregation rule for this case.

Reproduction: `modules/workflows/tests/parallel-output.test.ts`. This is explicitly
a characterization of an existing defect, not a correctness regression or a
claim that parallel outputs work. The original parity assertions failed.

The operator must choose either one final Output with an explicit Merge, or
multiple Outputs with a defined aggregate result. The worker and simulation must
then implement the same contract, including recovery. No arbitrary aggregation
or silent restriction was applied in this review.

## Remaining work and limits

- Newly created workspaces still seed the static owner scope set. They need a
  trusted permission ceiling derived from approved specs of enabled modules,
  passed consistently to bootstrap, provisioning and CLI. Current fixes cover
  inheritance of module grants inside existing tenants, not this global ceiling.
- Existing deployed sequences that lack privileges need a deliberate additive
  migration or administrator action on the exact objects. Default privileges
  only cover future objects; no user database was changed for this review.
- Pointer suggestions use declared graph schemas, not live business records.
  Unknown fields are identified as unknown. Discovery is bounded to 500 paths,
  16 levels and 50 visible matches. Array index 0 is explicitly an example.
- The visual gate editor still does not expose the full nested expression
  contract. The entire retry/failure/recovery option matrix and all custom-node
  extension scenarios have not been certified.
- Sandbox turn ownership survives HMR within one process, not a process crash.
  Formatter/install cancellation remains cooperative; a timeout no longer
  permits another writer to proceed.
- Preview reload retains durable data and session encryption keys, but resets
  in-memory preview settings as a restart would.
- No paid model invocation, external business action, production database test,
  new PR, commit or destructive database reset was performed for this review.
- Server PostgreSQL CI cases require configured connection roles. In-memory
  PostgreSQL coverage does not replace running those cases before deployment.

## Verification

Final `pnpm verify` passed: RuleSync consistency, all workspace typechecks,
repository tests, spec/blueprint/module validation and formatting. This includes
88 workflow tests, 217 sandbox package tests, 126 auth tests, 80 CLI tests and
75 platform tests. Three server PostgreSQL tests remained skipped because their
connection roles were not configured. No skips or timeout increases were added.

The earlier automations hook timeout coincided with a 780-second macOS sleep.
The unchanged endpoint suite, full automations suite and final repository run
all passed after wake. The earlier sandbox IPC failure was fixed and did not
recur in the final run.

Browser checks covered pointer selection and free typing, keyboard navigation,
mapping save and simulation, partial JSON input validation, canvas connection
drop menus and run-action visibility. Passing tests do not resolve the known
parallel-output defect or the coverage limits listed here; one workflow test
explicitly characterizes that unresolved divergence.
