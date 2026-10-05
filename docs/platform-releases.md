# Platform releases

Run **Actions > Platform release > Run workflow** on **main**. This manual action
creates a GitHub Release with signed artifacts and a complete Git changelog.
For a published, non-draft release, the final job publishes the same verified
SDK, CLI, generator and sandbox tarballs to npm. Container images remain separate.

## Prepare a version

Commit the intended stable `X.Y.Z` version before running the workflow. The root
`package.json` and SDK must have that version. `pnpm release-versions:check`,
part of `pnpm verify`, lists every other place that carries it, the scaffold's
SDK pin included: a generated application installs that pin, so leaving it
behind ships a template whose composition imports exports the SDK it pulls does
not have. All four public packages must carry the same committed stable version;
`release-versions:check` enforces it. The public package set comes from
`scripts/sdk-packages.json`. Version bumps are not performed by the release action.

Enter the version without `v`. Leave `previous_tag` empty to select the newest
older stable tag reachable from the selected commit. For the first release, all
commits are included. An explicit base must be an older reachable stable tag.
Prerelease versions are not supported by this workflow.

## Runtime compatibility

This source and newly generated applications pin Octane 0.8.0 with
`segment-state` 0.3.0. Modules using Octane must move both dependencies together;
`segment-state` 0.3.0 accepts Octane `^0.8.0`. The matching `@octanejs` adapters
are pinned in the workspace lockfile and generator template. Octane 0.8 renders
context providers as `<Context value={value}>`, so modules using
`<Context.Provider>` must update that syntax when they upgrade.
The offline catalog under `.ai/references/catalog` remains pinned to its verified
official artifact until a replacement artifact is published.

Use **dry_run** to build and sign downloadable Actions artifacts without creating
a Git tag or GitHub Release. Use **draft** to upload a complete release and leave
it unpublished for inspection. Both options default to false.

## Gates and artifacts

The workflow validates the selected source, installs the frozen lockfile, runs
release tooling tests, `pnpm verify`, `pnpm build`, `pnpm release:pack` and
`pnpm release:smoke`. A dirty checkout, version mismatch, altered package or
existing tag stops the release.

The release contains:

- Public package tarballs and their `sdk.json` manifest.
- `flowdular-X.Y.Z-source.tar.gz`, generated from the exact selected Git commit.
- `CHANGELOG.md`, containing every commit subject and complete body since the
  previous release, commit links, package versions and a changed-file summary.
- `RELEASE-NOTES.md`, a shorter overview linked to the full changelog.
- `release.json`, recording the source commit, base tag and artifact hashes.
- `SHA256SUMS` and its `SHA256SUMS.sigstore.json` signature bundle.

The build job has read access. A separate signing job obtains a short-lived GitHub
OIDC identity. Only the GitHub publication job has repository write access; it
installs no project dependencies and verifies the signature and artifact hashes
again before creating a tag.

The npm job runs only after the GitHub Release is published. It downloads the
signed artifacts, verifies their signature and hashes again, and publishes the
four tarballs in dependency order. Each package must list this repository's
`platform-release.yml` as an npm trusted publisher, with **Allow npm publish**
selected. Enter `platform-release.yml` as the workflow filename in npm, not its
full repository path. The job uses npm's GitHub OIDC identity, not a long-lived
npm token. Configure trusted publishing for all four packages before the next
release; a missing trust relationship leaves the
GitHub Release intact and fails the npm job. Rerun that failed job after fixing
the npm configuration. Drafts and dry runs do not publish to npm.

## What is signed

Cosign signs `SHA256SUMS` through Sigstore. Its certificate identifies this
repository's `platform-release.yml` workflow on `main` and the exact source SHA.
No long-lived signing secret needs to be configured. Sigstore's public transparency
log records signing identity and artifact digests, including repository/workflow
metadata when the repository is private. A dry run also signs and logs this data.

The Git tag is a lightweight, unsigned tag. GitHub's automatically generated
source ZIP/tar downloads are not covered by this signature. Use the attached
source archive, whose hash is in the signed checksum file.

Download all assets into an empty directory, then follow the exact Cosign command
in the release notes. It checks the expected workflow identity, GitHub OIDC issuer
and source commit. Finally run `sha256sum --check SHA256SUMS` (on macOS,
`shasum -a 256 --check SHA256SUMS`). Hash verification alone does not authenticate
the publisher; verify the signature first.

## Failure and recovery

A tag is created atomically and is never overwritten. The release is initially a
draft, and is published only after all uploads succeed. A failed upload leaves
an unpublished draft. A failure between tag creation and draft creation may leave
only the tag. Re-running with the same version intentionally fails in either case.

Inspect the failed run and the signed Actions artifact (retained for 14 days).
Recover manually by completing the matching draft and verifying its assets, or
prepare a new version. Do not move an existing published tag to different code.
Concurrent runs for the same version are serialized; the later run fails once the
tag exists.

Publishing with `GITHUB_TOKEN` does not trigger other tag-based workflows. Run the
container workflow separately when a container release is needed. If the npm job
fails, `pnpm release:publish --apply` remains a manual recovery path for the
signed tarballs; never rebuild or move an existing published tag.
