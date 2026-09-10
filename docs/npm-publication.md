# npm publication

Publish exactly four packages. The SDK, CLI and generator are at `0.2.2`;
the independently versioned sandbox is at `0.2.3` and depends on SDK `0.2.2`.

| Package              | Purpose                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `@flowdular/sdk`     | Shared SDK with separate server, client, UI, data, agent and core-module exports             |
| `flowdular`          | CLI providing the `flowdular` and `fd` commands                                              |
| `create-flowdular`   | Generator invoked by `npm create flowdular@latest my-app`                                    |
| `@flowdular/sandbox` | Independent coding application, launched with `npx @flowdular/sandbox`, depending on the SDK |

`@flowdular/sdk/ui` and `@flowdular/sdk/ui/styles` are SDK exports, not separate npm packages. The internal workspace packages are private and are assembled into the SDK during release. Business modules such as expenses, parties and catalog are installed as source from `Flowdular/official-modules`.

From the core repository:

```sh
pnpm release:pack
pnpm release:smoke
pnpm release:publish
```

`release-artifacts/sdk/sdk.json` lists only these four tarballs, their versions and SHA-256 digests. The publication command previews and verifies this exact set. After authenticating npm with permission to publish the names above, publish the verified artifacts:

```sh
pnpm release:publish --apply
```

Publish SDK first, then CLI, generator and sandbox. The script uses that order, skips an identical already-published version and refuses to overwrite different bytes. Nothing is published by packing, smoke testing or previewing. Do not publish the obsolete individual workspace tarballs from earlier local packaging experiments.

The SDK contains no coding sandbox application, coding-agent drivers, launcher or `sdk/sandbox` export.
The standalone sandbox imports SDK surfaces and declares an exact compatible SDK
dependency. Its source imports and package dependencies are adapted during packing;
internal workspace dependencies remain development-only. The platform's
`modules/sandbox` access/grant module stays in the SDK. Consumer smoke checks install
both tarballs, reject a sandbox bundled in the SDK, and start the standalone
launcher and HTTP application outside the monorepo.

After npm publication, install official-modules without local overrides, commit its portable pnpm lockfile and use an explicit `pnpm install --frozen-lockfile` step in both CI jobs. Run a fresh scaffold against npm. Local tarball tests prove package contents and integration, but do not prove npm availability before publication.

The official-modules repository is currently private. Anonymous catalog downloads require it to become public; keeping it private requires an authenticated distribution path. Repository visibility is unchanged by the npm release scripts.
