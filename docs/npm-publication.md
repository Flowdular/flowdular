# npm publication

Publish exactly three packages, all at version `0.2.0`:

| Package            | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `@flowdular/sdk`   | Shared SDK with separate server, client, UI, data, agent and core-module exports |
| `flowdular`        | CLI providing the `flowdular` and `fd` commands                                  |
| `create-flowdular` | Generator invoked by `npm create flowdular@latest my-app`                        |

`@flowdular/sdk/ui` and `@flowdular/sdk/ui/styles` are SDK exports, not separate npm packages. The internal workspace packages are private and are assembled into the SDK during release. Business modules such as expenses, parties and catalog are installed as source from `Flowdular/official-modules`.

From the core repository:

```sh
pnpm release:pack
pnpm release:smoke
pnpm release:publish
```

`release-artifacts/sdk/sdk.json` lists only these three tarballs, their versions and SHA-256 digests. The publication command previews and verifies this exact set. After authenticating npm with permission to publish the names above, publish the verified artifacts:

```sh
pnpm release:publish --apply
```

Publish SDK first, then CLI, then generator. The script uses that order, skips an identical already-published version and refuses to overwrite different bytes. Nothing is published by packing, smoke testing or previewing. Do not publish the obsolete individual workspace tarballs from earlier local packaging experiments.

After npm publication, install official-modules without local overrides, commit its portable pnpm lockfile and use an explicit `pnpm install --frozen-lockfile` step in both CI jobs. Run a fresh scaffold against npm. Local tarball tests prove package contents and integration, but do not prove npm availability before publication.

The official-modules repository is currently private. Anonymous catalog downloads require it to become public; keeping it private requires an authenticated distribution path. Repository visibility is unchanged by the npm release scripts.
