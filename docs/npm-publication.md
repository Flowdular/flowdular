# npm publication

Publish exactly four packages. The SDK, the CLI, the generator and the sandbox are at
`0.6.2`; the sandbox depends on SDK `0.6.2`. The root
`package.json` carries the SDK version, and `packages/cli/tests/sdk.test.ts` fails when the
CLI's `SDK_VERSION` constant drifts from `packages/sdk/package.json`.

| Package              | Purpose                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `@flowdular/sdk`     | Shared SDK with separate server, client, UI, data, agent and core-module exports             |
| `flowdular`          | CLI providing the `flowdular` and `fd` commands                                              |
| `create-flowdular`   | Generator invoked by `npm create flowdular@latest my-app`                                    |
| `@flowdular/sandbox` | Independent coding application, launched with `npx @flowdular/sandbox`, depending on the SDK |

`@flowdular/sdk/ui` and `@flowdular/sdk/ui/styles` are SDK exports, not separate npm packages. The internal workspace packages are private and are assembled into the SDK during release. Business modules are installed as reviewed source through a configured Module Studio source and plan.

The `Platform release` workflow publishes these four packages to npm after a
non-draft GitHub Release succeeds. Configure each package's npm trusted
publisher for repository `Flowdular/flowdular` and workflow filename
`platform-release.yml`. Select **Allow npm publish**, not stage-only access,
for all four packages before running a release. The workflow uses GitHub OIDC
and needs no npm token.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For a local package check or manual recovery, run from the core repository:

```sh
pnpm release:pack
pnpm release:smoke
pnpm release:publish
```

`release-artifacts/sdk/sdk.json` lists only these four tarballs, their versions and SHA-256 digests. The publication command previews and verifies this exact set. If the automated npm job failed, download and verify the signed GitHub Release assets, authenticate npm with permission to publish the names above, then copy the downloaded `sdk.json` and four `.tgz` files into `release-artifacts/sdk`. Do not rebuild the tarballs during recovery. Publish those exact assets:

```sh
mkdir -p release-artifacts/sdk
cp /path/to/verified-release/sdk.json /path/to/verified-release/*.tgz release-artifacts/sdk/
pnpm release:publish --apply
```

Publish SDK first, then CLI, generator and sandbox. The script uses that order, skips an identical already-published version and refuses to overwrite different bytes. Packing, smoke testing and previewing publish nothing. Do not publish the obsolete individual workspace tarballs from earlier local packaging experiments.

The SDK contains no coding sandbox application, coding-agent drivers, launcher or `sdk/sandbox` export.
The standalone sandbox imports SDK surfaces and declares an exact compatible SDK
dependency. Its source imports and package dependencies are adapted during packing;
internal workspace dependencies remain development-only. The platform's
`modules/sandbox` access/grant module stays in the SDK. Consumer smoke checks install
both tarballs, reject a sandbox bundled in the SDK, and start the standalone
launcher and HTTP application outside the monorepo.

After npm publication, test a fresh scaffold against npm and install a reviewed module from a configured source with a saved plan. Commit its source configuration, plan, install lock and portable pnpm lockfile, then use `pnpm install --frozen-lockfile` in CI. Local tarball tests prove package contents and integration, but do not prove npm availability before publication.
