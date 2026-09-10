# Flowdular system and module distribution audit

Date: 2026-09-10. Scope: local working tree, GitHub backlog, module boundaries,
CLI distribution and release readiness. This is an audit and proposed sequencing,
not an implementation of module installation or a production security assessment.
The working tree contains concurrent work; findings describe the inspected snapshot.

## Repository ownership

The operator confirmed that [Flowdular/flowdular](https://github.com/Flowdular/flowdular)
is the official core repository. [Flowdular/official-modules](https://github.com/Flowdular/official-modules)
is the intended official module repository. Both repositories were empty when
queried. The local Git remote still points to `moxxy-ai/coreloom`; its 22 issues
are all open. The two Flowdular repositories returned no issues.

Publish the core history to the official destination and deliberately resolve
backlog ownership, links and redirects. Preserve issue history where GitHub
transfer permits it. Do not leave two independently active core backlogs. No
repository settings, remotes or issues were changed during this audit.

## Executed checks

| Check                                           | Result                                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| `pnpm verify`                                   | Exit 1 at the final formatting check                     |
| Typecheck, tests and validation inside that run | Passed; 1371 tests passed and 3 skipped                  |
| Sandbox package                                 | 229 tests passed                                         |
| Formatting failure                              | `docs/assets/flowdular-github-avatar-flat-prompt.md`     |
| `pnpm flowdular module validate --json`         | Success for all 12 manifests                             |
| Dependency range comparison                     | 22 declarations exclude the installed dependency version |

The three skipped tests are in database-testing. This local run is not evidence
that PostgreSQL integration tests ran. CI already has PostgreSQL coverage with
restricted runtime/background/migrator roles. A build and deployed product flows
were not exercised in this audit. Earlier preview failures are not present in
this test run.

## Findings beyond the existing backlog

### A1. Declared module compatibility is not enforced

All 22 dependency edges in the current module manifests exclude the version of
their dependency present in this workspace. For example:

| Consumer                                        | Dependency         | Required | Present  |
| ----------------------------------------------- | ------------------ | -------- | -------- |
| `profile.core`                                  | `auth.core`        | `^1.0.0` | `0.10.0` |
| `auth.core`                                     | `system.core`      | `^0.1.0` | `0.5.0`  |
| `expenses.core`, `parties.core`, `catalog.core` | `auth.core`        | `^0.1.0` | `0.10.0` |
| `workflows.core`                                | `agents.core`      | `^0.6.0` | `0.9.1`  |
| `automations-workflows.integration`             | `automations.core` | `^0.2.0` | `0.4.0`  |

The comparison uses caret semantics: `^0.1.0` excludes `0.2.0` and later.
This proves stale or inconsistent declarations, not that every combination has
an actual runtime defect. The validator currently reports success anyway.

`packages/kernel/src/module-registry.ts` checks dependency existence/order;
`packages/cli/src/module-sync.ts` reduces dependencies to IDs. Neither resolves
the declared ranges. The manifest schema accepts a nonempty version string.

Before independent releases, use one shared semver compatibility policy in
validation, enablement and runtime registration. Reconcile ranges against
tested compatibility rather than replacing them with `*`. Add a platform API
compatibility range and clean-consumer tests. This should be a new backlog item.

### A2. The CLI manages workspace modules, not external distribution

The implemented module commands include list, validate, sync, enable, disable
and new. There is no registry search, download/install, source lock or update
protocol. Discovery filters module manifests through `/modules/`; filesystem
validation skips `node_modules`. Enablement adds platform dependencies using
`workspace:*`.

A plain package-manager install therefore does not provide the desired module
workflow. The proposed MVP installs reviewed source artifacts into the consumer's
`modules/` workspace, then uses the existing explicit enablement path. See
[RFC 0003](../rfc/0003-official-modules.md).

### A3. Moving reference modules would break agent preparation

`packages/sandbox/src/server/reference.ts` copies `modules/catalog` into
`reference/example-module` and `modules/profile` into `reference/adapter-module`.
Skills also refer to these modules. Before removing catalog from core, provide a
versioned reference bundle with a tested source of truth. Avoid maintaining an
untracked second implementation in core. Keep profile bundled initially.

### A4. Publication needs a clean consumer boundary

The inspected SDK and module packages are private; only the scaffolder is
configured as publishable. Its default platform template requests
`@flowdular/module-auth ^0.8.0`, whereas this workspace contains `0.10.0`.
There is no complete SDK/module publication pipeline in the inspected workflows.
This extends existing issue #16.

`workspace:*` itself is not a blocker to package publication: pnpm rewrites
workspace dependencies during packing/publishing. However, copying raw source
to another repository does not provide those dependencies or a supported release
contract. Define which SDK packages are published and test a generated consumer
against packed/released artifacts without resolving imports back into this repo.
See [pnpm workspace publishing](https://pnpm.io/workspaces).

### A5. Core and optional feature boundaries need explicit presets

All 12 modules are currently enabled. The module folder alone does not imply
independent distributability. Auth owns platform composition types; system's
package uses auth contracts while auth declares a dependency on system. Resolve
or document that package-level coupling before attempting to externalize either.

| Destination                                                  | Modules                                                                              | Reason                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Core baseline                                                | `system`, `auth`                                                                     | Platform composition, identity, permissions and settings            |
| Bundled product defaults                                     | `users`, `profile`                                                                   | Account administration and personal settings                        |
| Optional first-party platform preset, initially in core repo | `agents`, `workflows`, `automations`, `automations-workflows-integration`, `sandbox` | Platform features with shared contracts and lifecycle dependencies  |
| Official modules repository                                  | `expenses`, `parties`, `catalog`                                                     | Business modules suitable for an independent installation lifecycle |

Preserve module IDs, permission names, SQL namespaces and migration history when
moving repositories. A `.core` suffix is not a reason to rename a deployed module.

## Existing issue triage

Links below intentionally use the current issue location. “Confirmed” means
the relevant local code or configuration was inspected, not that every failure
was reproduced against production. Acceptance lists in issue bodies are not
treated as proof of implementation.

| Issue                                                                                    | Audit disposition and next action                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1 Retention and adjacent controls](https://github.com/moxxy-ai/coreloom/issues/1)      | Roadmap epic. Backup/restore, legal hold and audit retention rules precede erasure. Separate platform invariants from optional administration UI.                                                          |
| [#2 Enterprise modules](https://github.com/moxxy-ai/coreloom/issues/2)                   | Roadmap epic. Good future official modules: delivery, documents, approvals and directory integration, after their core contracts exist.                                                                    |
| [#3 Production invite/reset delivery](https://github.com/moxxy-ai/coreloom/issues/3)     | Confirmed production gap: development-only delivery; invitations fail without mail and password reset has no delivery. Prioritize a production delivery port/provider.                                     |
| [#4 Automation credential key deployment](https://github.com/moxxy-ai/coreloom/issues/4) | Confirmed required production key with no matching deployment manifest configuration. Document/provision the secret and test production boot.                                                              |
| [#5 OIDC verification](https://github.com/moxxy-ai/coreloom/issues/5)                    | Confirmed email-based sign-in path without ID-token validation in the inspected implementation. High priority before production SSO claims: signature, issuer, audience, nonce and stable subject binding. |
| [#6 Auth scope backfills and RLS](https://github.com/moxxy-ai/coreloom/issues/6)         | Code supports the reported RLS visibility risk. Reproduce with restricted PostgreSQL migrator and introduce a corrective migration or explicit repair; do not rewrite applied migrations.                  |
| [#7 Swallowed audit failures](https://github.com/moxxy-ai/coreloom/issues/7)             | Confirmed catch/log path without durable health evidence. Define failure policy and expose operational detection.                                                                                          |
| [#8 Service audit actor](https://github.com/moxxy-ai/coreloom/issues/8)                  | Confirmed schema CHECK permits user/agent only. Add a compatible migration and service-actor persistence test.                                                                                             |
| [#9 Truncated audit tail](https://github.com/moxxy-ai/coreloom/issues/9)                 | Open design/security finding; not independently reproduced in this audit. Require a separately retained anchor if completeness is promised.                                                                |
| [#10 Automation migration adoption](https://github.com/moxxy-ai/coreloom/issues/10)      | Confirmed index-only adoption checks for 0003/0004. Check policy/grant/schema semantics and reject partial adoption.                                                                                       |
| [#11 Encryption key rotation](https://github.com/moxxy-ai/coreloom/issues/11)            | Open data-lifecycle finding; full rotation exercise not performed. Define key IDs, active/decrypt keys and resumable rewrapping before advertising rotation.                                               |
| [#12 Backup/restore/PITR](https://github.com/moxxy-ai/coreloom/issues/12)                | No operational runbook found. Add and actually exercise restoration, including encrypted data and keys.                                                                                                    |
| [#13 External-effect approval](https://github.com/moxxy-ai/coreloom/issues/13)           | Confirmed external/destructive execution refusal. Implement verifier/approval flow before connectors and outbound business actions; do not weaken the default denial.                                      |
| [#14 Boot preflight migration lease](https://github.com/moxxy-ai/coreloom/issues/14)     | Confirmed read uses migration purpose. Use the appropriate tenant-aware runtime read contract.                                                                                                             |
| [#15 Legacy database state copy](https://github.com/moxxy-ai/coreloom/issues/15)         | Confirmed old module SQLite filenames in state migration. Distinguish transferable secrets from unsupported database migration and report it accurately.                                                   |
| [#16 SDK publication](https://github.com/moxxy-ai/coreloom/issues/16)                    | Direct blocker for independent official modules and the standalone starter. See A4.                                                                                                                        |
| [#17 Enterprise marketing claims](https://github.com/moxxy-ai/coreloom/issues/17)        | Confirmed EN/PL SSO, SCIM and audit-export claims. Align copy with shipped capabilities.                                                                                                                   |
| [#18 Async settings contract](https://github.com/moxxy-ai/coreloom/issues/18)            | Confirmed synchronous kernel persistence shape. Evolve the contract with lifecycle/consumer tests.                                                                                                         |
| [#19 Workflows success-route tests](https://github.com/moxxy-ai/coreloom/issues/19)      | Inspected HTTP tests lack the requested successful POST coverage. Add handler-reaching authenticated and CSRF-valid cases.                                                                                 |
| [#20 Sandbox directory N+1](https://github.com/moxxy-ai/coreloom/issues/20)              | Confirmed listScopes per candidate. Introduce bounded bulk lookup and query-count evidence.                                                                                                                |
| [#21 Password environment argument](https://github.com/moxxy-ai/coreloom/issues/21)      | Lower priority; issue describes fail-closed behavior and clarification. Recheck documented command behavior before deciding closure.                                                                       |
| [#22 BIGINT parity](https://github.com/moxxy-ai/coreloom/issues/22)                      | Some normalization fixes are present. Keep the systemic item open until shared decoding and PostgreSQL parity evidence cover the remaining consumers.                                                      |

## Recommended order

1. Establish the official core repository and backlog location; finish the current
   rename/verification baseline. Prioritize production identity, delivery,
   migration and data recovery issues independently of repository restructuring.
2. Enforce dependency ranges and define SDK releases/clean-consumer testing (#16).
3. Implement the registry artifact contract, installer and its failure tests.
4. Release/install `expenses` end to end before removing its bundled copy. Then
   move `parties`; move `catalog` after replacing agent reference preparation.
5. Add safe updates and module presets; build further official business modules
   against the public platform capabilities from #2.

The auto-review gate added in the preceding work is useful delivery evidence.
It cannot guarantee arbitrary model output is correct. Independent executable
checks, compatibility tests and review of the exact released artifact remain
necessary. The proposed release contract makes those checks reusable across both
repositories.
