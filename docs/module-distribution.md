# Module Studio

Module Studio uses one reviewable plan for a module source change. A platform
checkout owns its sources in `flowdular.module-sources.json`, its exact plans in
`module-plans/<sha256>.json`, and installed source hashes in
`flowdular.modules.lock.json`. Commit these files with the application when
they change. A catalog can be a local JSON file or an HTTPS URL. A Git source
names a repository and a full commit, and may itself be local or HTTPS. No
publisher or repository name is built into the installer.

```sh
pnpm flowdular module source add community https://modules.example/registry/index.json --apply
pnpm flowdular module source add team https://github.com/acme/modules.git \
  --git-commit <40-character-commit> --catalog-path registry/index.json --apply
pnpm flowdular module source add local ./registry/index.json --apply
pnpm flowdular module source list
pnpm flowdular module search expenses --source community
pnpm flowdular module plan expenses.core@1.2.0 --source community --apply
pnpm flowdular module plan show <plan-id>
pnpm flowdular module apply <plan-id> --apply
pnpm flowdular module enable expenses.core --apply
pnpm build
```

`source add`, `plan`, and `apply` preview their work unless `--apply` is present.
With exactly one configured source, `--source` may be omitted. `module plan
list` shows saved plans; `module plan remove <plan-id> --apply` deletes an
obsolete plan. At most 32 plans may exist at once, with 4 MiB per plan and
8 MiB in total. A plan records the selected
releases, artifact SHA-256, Git commit where applicable, dependency closure,
requested permissions, migration file hashes, and server/client build impact.
Its ID hashes the plan content. Applying it refuses changed workspace module
manifests or a changed install lock and verifies every artifact again. If the
source is no longer available, regenerate or provide it again; the plan does
not contain executable source bytes.

Installation copies reviewed source into a configured module root and writes
the install lock. It does not run downloaded scripts, npm install, migrations,
or permission grants. `module enable --apply` links the package, regenerates
composition and follows the platform's scope grant process. Rebuild and
restart the application to serve new code. A deployed container shows plans
and module state in Administration, Module Studio; it never writes its own code.
For creating or changing your own module, the same view links to Sandbox when
`sandbox.core` is active. Sandbox keeps the approved spec hash, gate and PR
checks, and delivers to the workspace or its configured Git repository.

## Trust and recovery

Only a configured host CLI resolves sources. Sandbox specialists do not gain
network, Git, database or filesystem permissions from a source entry. HTTPS
downloads reject redirects and have time and size limits. HTTPS artifacts must
use the catalog origin and a path containing their declared source commit.
The artifact digest is verified after download. Git checkouts verify their full
commit. Catalogs and artifacts are bounded; paths, manifests, package scripts,
review evidence and approved specs are checked before a plan is saved. A
checksum identifies bytes but does not certify a publisher, so review the
source and permissions before `module apply` and `module enable`.

Updates use `module plan <id[@version]> --source <name> --update --apply`.
The installer refuses local changes, changed historical migrations and
downgrades. `module validate --locked` checks installed file hashes. Installs
use an exclusive transaction directory; after a process crash, run `module
recover` and then `module recover --apply`. Recovery restores source and lock
state, not database migrations. Source-list edits use a separate
`flowdular.module-sources.json.lock` directory. If a host process crashes
during that short write, confirm no other source command is running and remove
that stale directory before retrying.
Plan writes use the same atomic pattern and a `module-plans.lock` directory.
After a crash, confirm the writer has stopped and remove a stale plan lock
before retrying; no partial plan is published.

Scripts that called `module install` or `module update` with `--registry` must
add that catalog as a named source, save a plan, and apply its ID. An existing
`flowdular.modules.lock.json` remains the installed-source record, so an
already managed module can use `module plan <id> --update --apply` for its next
release. No direct registry installation path remains.
Automation that imported `installModule` from `flowdular/distribution` must use
the host CLI plan and apply commands; that direct install export was removed.

The old `official-modules` Sandbox delivery target was removed. Change
`sandbox.delivery.targets` to `workspace` or `git-pr`; `git-pr` points to the
platform repository configured in `flowdular.json`. A catalog publisher can
use any Git repository and publish immutable artifacts independently. Historical
review and RFC documents retain the old project name as provenance.

## SDK publication and consumer checks

```sh
pnpm release:pack
pnpm release:smoke
```

`release-artifacts/sdk/sdk.json` lists the SDK, CLI, project generator and
Sandbox tarballs with SHA-256 digests. Publication is separate from packing
and smoke tests. The project generator and SDK must be released together so a
new application's module tooling sees the same contracts.
