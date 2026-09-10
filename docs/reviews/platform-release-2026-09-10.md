# Platform release review, 2026-09-10

Scope: `.github/workflows/platform-release.yml`, the scoped installation/test
changes in `ci.yml` and `sdk-release.yml`, `scripts/platform-release.mjs`,
`scripts/tests/platform-release.test.mjs`, `docs/platform-releases.md` and its
link in `docs/README.md`.
Concurrent sandbox package extraction files are outside this change.

## Evidence

- Correctness: the manual workflow takes a committed stable version and optional
  reachable base tag. Sixteen Node tests exercise initial/ranged changelogs,
  complete commit bodies, exact archived source, version/source mismatch, dirty
  checkout, existing tags, stale output, package identity, modified tarballs,
  missing checksum coverage, unsigned extra files, paths and symbolic links.
- Security: build has read access; only signing has OIDC access; only publication
  has repository write access. Checkout credentials are not persisted. User
  input travels through environment variables and argument arrays, not shell
  interpolation. Both privileged jobs bind the artifacts to the selected source;
  publication verifies the Cosign identity, issuer and commit before remote
  writes. Signature authenticity is enforced by the workflow, not by the helper's
  signature-file presence check. No tenant, database, CSRF or application
  authorization boundary changes. Public Sigstore metadata is documented.
- Compatibility: public package names come from `sdk-packages.json`, not a fixed
  package count. Packed manifests, versions and hashes are checked before copying.
  No runtime exports, generated composition, module specs or migrations change.
  Existing CI keeps its gates and uses an explicit frozen install instead of the
  unsupported setup input. npm and container publication remain separate.
- Lifecycle: per-version concurrency is serialized. Atomic ref creation cannot
  overwrite tags. Tests prove a failed upload never publishes, a ref conflict
  stops immediately, missing signatures cause no remote writes, and draft mode
  remains unpublished. Failures can leave a tag or draft; manual recovery and
  artifact retention are documented. Preparation refuses stale output. Work is
  linear in history and artifact bytes, with one asset buffer at a time and a
  64 MiB Git output limit; jobs have timeouts. Test fixtures clean their owned
  temporary directories.
- UI: no rendered application components, translations or interactions change.
  The workflow's typed manual inputs and maintainer documentation were reviewed.

## Verification

- `node --test scripts/tests/platform-release.test.mjs`: 16 passed, none skipped.
- Actionlint 1.7.12: all three changed workflows pass (ShellCheck not installed).
- `git diff --check`: passes.
- `pnpm verify`: final complete run passes (rules, references, types, module tests,
  schema validation and formatting). The initial run failed two sandbox tests
  while another full suite ran concurrently: a 15-second timeout and an aborted
  preview call. Both files then passed unchanged (23 tests), followed by the
  successful full rerun. No timeout or assertion was changed. The default suite's
  PostgreSQL-only cases remain conditional on the PostgreSQL matrix environment.
- `pnpm build`: CLI build/smoke, generated module sync, client and SSR build pass.
- Real package integration: prepared and verified all four existing public
  tarballs in an isolated committed fixture, including SDK 0.2.0 and sandbox
  0.2.1. The first attempt exposed the unnecessary lockstep version restriction;
  implementation was corrected and reviewed again. A new regression fails when
  that restriction is restored in a temporary copy, and passes in the final code.
  SDK version mismatch remains rejected; companion versions stay independent.

No actionable findings remain in the reviewed implementation.

The GitHub OIDC signing and release upload path has not been dispatched. Unit
transport tests do not claim to authenticate a real signature or publish a real
release. First run should use `dry_run`; this still creates a public Sigstore
transparency entry. Git tags and GitHub-generated source archives are unsigned;
the attached source archive is covered by the signed checksum file.
