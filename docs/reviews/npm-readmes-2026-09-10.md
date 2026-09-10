# npm package README review

Scope: README.md and original banner assets for @flowdular/sdk, flowdular and create-flowdular; release assembly copies the SDK/CLI assets and the generator files allowlist includes assets. The publication guide now names the supported explicit frozen-install CI step.

Requirements: each package has npm-version, Node and MIT badges, the existing Flowdular banner, a package-specific quick start, public API or command examples, requirements, cross-package links and support links. The generator explains local authentication reset and pnpm; the CLI separates archive installation from enabling and granting scopes; the SDK documents source-toolchain and browser/server boundaries.

Evidence: scoped Prettier check passed. node scripts/package-sdk.mjs /tmp/flowdular-readme-pack passed. All three actual tarballs contain package/README.md and package/assets/flowdular-banner.png; extracted banner bytes equal docs/assets/flowdular-readme-banner.png and README badges are present. pnpm build passed. Full pnpm verify passed: typecheck, 1290 tests, schema/module validation and formatting.

Compatibility/security/lifecycle: package names, versions, imports and executable behavior are unchanged by this documentation scope. No auth, tenant, database, migrations or background-work implementation changed. Packing adds a constant number of asset copies and retains owned staging cleanup. No runtime regression tests were added for prose and copied assets.

Presentation: the existing banner was visually inspected. Official Modules uses a separate existing SVG with generic blocks, reviewed and pushed in 9ed131b. Both remote CI jobs passed in run 34518254032, including 147 PostgreSQL tests. Package banner URLs use jsDelivr npm paths so they do not depend on private GitHub raw files. They become available only after a new npm release includes the assets. Repository links still require access while private.

Release limitation: npm version 0.1.0 is already published and immutable. This review does not publish packages or change versions; updated README/artwork needs a subsequent release. Temporary verification packs must not replace the published release manifest or be republished as 0.1.0.

Separate published-consumer check found that create-flowdular 0.1.0 initially omits applicationBasePath from its generated client composition. Current source template already contains the export. The published CLI command pnpm flowdular module sync --apply regenerated the composition; the consumer then passed typecheck and all 11 tests on Node 24.18.0 without local package overrides.

Final assessment: requested documentation and packaging changes pass the applicable checks. Published npm consumer issue and next-release requirement are retained above as release limitations.
