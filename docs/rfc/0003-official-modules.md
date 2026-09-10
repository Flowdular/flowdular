# RFC 0003: Official module distribution

Status: MVP implemented on 2026-09-10. The deployed contract is documented in [module distribution](../module-distribution.md). The sections below retain the original proposal; the MVP uses bounded JSON source bundles instead of archives, separates npm linking into enablement, and leaves scope grants to the existing auth flow. SDK publication is performed by the operator.

Core repository: [Flowdular/flowdular](https://github.com/Flowdular/flowdular).
Module repository: [Flowdular/official-modules](https://github.com/Flowdular/official-modules).
Evidence and backlog: [system audit](../reviews/system-audit-2026-09-10.md).

## Outcome

An operator can discover an official module, preview installation, download a
specific reviewed version into their workspace and explicitly enable it using
the existing CLI. Installed source remains editable by the operator and sandbox.
Updates detect local edits and cannot silently overwrite them.

The official repository holds source, a generated catalog and immutable release
artifacts. It does not need a custom registry server initially. Core SDK packages
have their own supported publication contract. The first release proves the
whole path using `expenses`, followed by `parties` and then `catalog`.

## Boundaries

Keep auth/system in core, users/profile bundled, and agent/workflow/automation/
sandbox features in an optional platform preset within the core repository for
the first iteration. Move the three business modules only once external install
and tests work. Do not change deployed module IDs or migration namespaces.

Use source installation under `modules/` for the MVP, matching today's discovery,
generated composition and sandbox editing model. Loading packages directly from
`node_modules` is a separate future capability requiring explicit discovery and
editing semantics. Downloading is a host/operator operation, never a new network
or installation permission for sandbox agents.

## Repository layout

```text
official-modules/
  README.md
  LICENSE
  AGENTS.md
  CONTRIBUTING.md
  CODEOWNERS
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  registry/
    index.json                       # generated from released module records
    modules/<module-id>.json          # immutable version metadata references
  modules/
    expenses/
    parties/
    catalog/
  scripts/
    validate-registry.mjs
    build-release.mjs
  tests/consumer/
  .github/workflows/
    validate.yml
    release.yml
```

Each module retains its manifest, package metadata, specification, source,
translations, immutable migrations and behavior tests, with a README and
changelog. Reuse core validators and the shared agent skill contract. Keep the
registry schema canonical in core contracts rather than maintaining conflicting
schemas in both repositories. Consumer fixtures must use real packed/released
SDK artifacts rather than aliases into a neighboring core checkout.

## Release contract

A version record includes module ID/version, package identity, required platform
API range, module dependency ranges, artifact URL/digest, source commit, license
and release evidence. Select exact dependency versions during resolution and
record them in the consumer lockfile. Never silently replace a released version's
bytes. Registry snapshots and release metadata must be obtained from a configured
trusted publisher; a checksum downloaded with an untrusted artifact does not
authenticate that publisher.

Release automation validates schemas and dependency compatibility, executes tests,
packs source without secrets/state/build debris, and checks a clean consumer.
The review report binds to the source/artifact being released and records actual
commands, results, requirements and unresolved findings. Missing, failed or stale
required evidence blocks publication. Use CI-controlled release credentials and
publisher provenance where supported. [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements/)
describes provenance for npm artifacts; a GitHub source archive needs its own
authenticated release verification policy.

Source archive dependencies must resolve outside the authoring monorepo. For SDK
npm packages, pnpm rewrites workspace ranges during packing/publishing; verify
the resulting package rather than assuming the source manifest is distributable.
See [pnpm workspace publishing](https://pnpm.io/workspaces).

## Proposed CLI surface

These commands do not exist yet:

```sh
flowdular module search expenses --source official
flowdular module info expenses.core
flowdular module install expenses.core@<version>
flowdular module install expenses.core@<version> --apply
flowdular module update expenses.core
flowdular module validate --locked
```

Mutating commands produce a plan by default; `--apply` performs that exact
resolved plan after revalidation. The plan shows source, versions, dependency
closure, destination files and conflicts. Provide the normal structured JSON
output, stable error codes and capability descriptors, with matching help,
policies and tests. Registry search/info are read-only network operations.
Installation is a bounded host workspace mutation. Do not classify it by
bypassing the existing approval restrictions for external business effects.

Installation does not activate the module, grant permissions or apply database
migrations. Continue through the existing explicit `module enable --apply` and
tenant permission workflows. Dependency acquisition, package-manager resolution
and schema application must be visible distinct steps in the plan.

## Lock and update semantics

Proposed file: `flowdular.modules.lock.json`. Record exact module and dependency
versions, platform compatibility, publisher/source commit, artifact digest and
original installed file hashes. Use hashes to detect local edits, including
deletions and new files. Define canonical path/byte hashing and schema versioning.
The package-manager lockfile remains responsible for npm dependencies.

An update previews the upstream diff and local modifications. Refuse automatic
replacement of locally changed files; offer a reviewable merge workflow later.
Do not provide a default force-overwrite escape hatch. Preserve immutable applied
migrations and block unsupported downgrades. Removing source is distinct from
disabling a module or deleting tenant data; removal is outside the first MVP.

## Installer sequence and failure behavior

1. Read workspace configuration and installed lock; resolve trusted metadata,
   semver/core compatibility and the dependency closure. Reject missing modules,
   cycles, conflicting IDs/versions and destinations before changing files.
2. Download to a temporary directory with timeouts and size limits; verify
   authenticated metadata and artifact digests. Defend against archive traversal,
   absolute paths, symlink escapes, excessive expanded size and file count.
3. Validate manifest/package identity, dependencies, expected paths and source
   contract. Do not execute downloaded lifecycle scripts during validation.
4. Stage source and the proposed lock/config changes. Refuse existing unowned
   destinations and concurrent edits. Commit workspace changes transactionally
   with a journal/recovery path; serialize concurrent installations.
5. Resolve package dependencies using an explicit safe script policy and run
   scoped checks. Restore installer-owned file/config changes on failure without
   deleting pre-existing user work. Retrying an interrupted installation must be
   idempotent and recoverable.
6. Report installed versus enabled state and the explicit next activation step.
   Do not promise rollback of irreversible database migrations.

Honor configured module roots or reject unsupported roots explicitly. Fix the
current hardcoded discovery assumption before claiming arbitrary roots work.
The installer, module validator, enablement and runtime registry must share the
same dependency semantics.

## Agent review and acceptance evidence

Use the existing sandbox auto-review gate for edited module deliveries. Add the
same evidence requirements to official-module release CI, independently of an
agent's final message. The report covers requirements, public contracts, tenant
isolation/permissions, migrations, UI states where applicable, and regression
tests. Any edit after review invalidates that review. Tests cannot prove that
all bugs are absent; require explicit limitations instead of a generic “passed”.

Required executable cases before the first external module replaces its bundled copy:

- Generate a clean starter, install a released module, explicitly enable it and
  exercise its authenticated API and UI without source aliases to either repo.
- Test declared compatible core versions, rejected incompatible ranges, dependency
  closure/cycles/conflicts and locked reproducibility.
- Exercise module migrations and isolation on PGlite and restricted PostgreSQL
  runtime/background/migrator roles, including fresh install and upgrade.
- Reject altered digests, untrusted metadata, unsafe archives, unexpected package
  identity, and lifecycle-script execution during validation.
- Preserve local edits, reject conflicting destinations, recover from interrupted
  downloads/staging/package resolution, and prove idempotent retry.
- Block missing, failing or stale review/test evidence; verify the release artifact
  contains precisely the reviewed source and the clean consumer uses that artifact.
- Exercise sandbox edits and eject on an installed module. Before moving catalog,
  test preparation of its pinned agent reference bundle in an offline session.

## Implementation slices

1. Correct version declarations based on tested compatibility; implement shared
   semver validation and platform API compatibility. Prove today's invalid ranges
   fail with regression tests.
2. Publishable SDK/starter contract and isolated consumer smoke tests (existing
   issue #16); decide official repository/backlog migration.
3. Registry schema, official-module repository skeleton and reproducible source
   release pipeline; first artifact is expenses.
4. CLI search/info/install with lock, safe extraction and recovery tests. Use
   existing enablement and generation instead of a second composition system.
5. Move expenses only after consumer and sandbox acceptance; then parties.
   Replace the catalog reference path before its move. Update presets via CLI
   generation, preserving tenant state and migration history.
6. Updates and additional business modules. Address the production security and
   operational backlog independently; repository separation does not resolve it.
