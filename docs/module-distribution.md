# Installing official modules

Core is maintained in [Flowdular/flowdular](https://github.com/Flowdular/flowdular).
[Flowdular/official-modules](https://github.com/Flowdular/official-modules) owns
expenses, parties and catalog, including their source, reviews and immutable
release artifacts. The landing is in [Flowdular/landing](https://github.com/Flowdular/landing).

```sh
pnpm flowdular module search expenses
pnpm flowdular module info expenses.core
pnpm flowdular module install expenses.core@0.6.1
pnpm flowdular module install expenses.core@0.6.1 --apply
pnpm flowdular module enable expenses.core --apply
pnpm flowdular module validate --locked
```

Without `--apply`, installation and updates return a plan and write nothing.
Installation downloads source into the first configured module root and writes
`flowdular.modules.lock.json`. It does not install npm dependencies, run downloaded
scripts, activate modules, grant scopes or touch a database. Enablement links npm
packages with install lifecycle scripts disabled, generates composition and runs
its existing scope-grant flow. Review the source before enabling it.

`module update <id[@version]> [--apply]` requires an installer-managed module and
refuses local source changes, removed or edited historical migrations, incompatible
versions and downgrades. Additional source files count as local edits. Generated
`dist`, `node_modules` and Git metadata do not. `module validate --locked` requires
a lock and checks source hashes as well as ordinary manifest/dependency validation.

The installer resolves a consistent dependency closure, including diamond
constraints, within a bounded search budget. Existing workspace/package versions
are preserved. Registry and runtime validation share semver semantics, including
pre-1.0 caret ranges. Every module declares `platformApi` as a range
(`^0.1.0`); the current platform API is `0.1.0` and `module search --compatible`
filters releases by it. A release that declares `requires` is resolved together
with the newest compatible release providing each required capability.

## Trust and recovery

The default catalog is the official repository's `registry/index.json`. HTTPS
artifact URLs must point to the declared immutable commit in that same repository.
Downloads have time and size limits. Source bundles are bounded JSON records of
regular files, validated for path escapes, duplicate names, digest mismatches,
identity, portable dependencies and stale/missing review evidence. No archive
extraction or install lifecycle scripts execute during source installation.

A checksum does not authenticate an arbitrary publisher. The trust root is the
configured official repository over HTTPS. An operator can explicitly supply
`--registry /absolute/path/index.json` for an offline catalog; artifacts must stay
inside that catalog directory. Third-party remote registries are not supported.
A review report is an assessment, not a guarantee or a defense against a malicious
publisher. Official release CI also executes the checks independently.

Concurrent installs share an exclusive transaction directory. Recover an
interrupted operation with `module recover` and `module recover --apply` after
its owner process has exited. Recovery restores the previous source and module
lock and refuses to discard conflicting edits. Keep the transaction directory
when a conflict is reported. Source recovery never rolls back database migrations.
Installation and updates are host/operator capabilities and do not expand sandbox
agents' network, filesystem or tool permissions.

## SDK publication and consumer checks

```sh
pnpm release:pack
pnpm release:smoke
# Also install and test actual source artifacts from the official repo:
node scripts/smoke-sdk.mjs release-artifacts/sdk /path/to/official-modules/registry/local-index.json
```

`release-artifacts/sdk/sdk.json` lists exactly `@flowdular/sdk`, `flowdular`, `create-flowdular` and `@flowdular/sandbox`, with versions, tarballs
and SHA-256 digests. Publish those tarballs with `npm publish <tarball> --access public`.
Publish all SDK dependencies before consumers install the starter. The three
business modules and the landing are not in this npm publication set. Keep release
artifacts outside runtime state directories; creating both `.flowdular` and legacy
`.coreloom` state would correctly stop the application.

The smoke test creates a separate project and resolves SDK dependencies from
packed artifacts, without aliases or symlinks into core sources. With a module
catalog it installs all module source artifacts, enables their source composition,
checks the lock, typechecks and executes the consumer's tests. Its composition
check does not grant tenant scopes; auth CLI tests cover that separate boundary.

Sandbox examples use `.ai/references/catalog`, generated from a reviewed official
artifact. `pnpm reference:check` verifies every file against the pinned provenance
record. Do not edit the generated reference. To update it, build the CLI and run
`scripts/module-reference.mjs` with `--artifact`, `--sha256`, `--source-commit` and
`--apply`. Skills and sandbox preparation refer to that offline snapshot.

`pnpm release:publish` previews the exact publication set after validating every
artifact digest. The operator can then use `pnpm release:publish --apply` after npm
authentication. It skips already-published identical tarballs and stops if a
version exists with different bytes. No npm publication is performed by packing,
smoke testing or the default publication preview.

The SDK is assembled from private internal workspaces. Import UI from `@flowdular/sdk/ui` and styles from `@flowdular/sdk/ui/styles`; use `@flowdular/sdk/server`, `client`, `contracts` or `modules/<name>` for other surfaces. There is no root SDK barrel, so browser imports do not load server entrypoints. See [npm publication](npm-publication.md).
