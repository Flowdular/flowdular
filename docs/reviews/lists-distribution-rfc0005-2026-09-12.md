# RFC 0005 first wave review record (2026-09-12)

Scope: the wave the owner accepted on 2026-09-12: I1 (official modules on
the current core), I4 with the small I6 items (review follow-ups and the
open audit items), I2 (server-side lists), I3 (selection and bulk actions),
I7 (documentation) at any point. This record grows with the wave.

## I1: official modules against the current core

Delivered in `Flowdular/official-modules` pull request #1 (branch
`feat/core-0.2-compat`, commits `d7544e8` and `b8281b3`), tested against the
SDK packed from this tree at `flowdular` 0.2.4, `@flowdular/sdk` 0.2.4,
`create-flowdular` 0.2.6.

| Module        | Version | Spec hash (sha256, first 16) |
| ------------- | ------- | ---------------------------- |
| catalog.core  | 0.7.0   | `ec931c78f351c7fc`           |
| expenses.core | 0.7.0   | `5d212d7c59e75e41`           |
| parties.core  | 0.9.0   | `7fb80fd6d926c167`           |

- Ranges: `system.core ^0.7.0`, `auth.core ^0.13.0`, `platformApi ^0.1.0`
  in module.json and spec; the kernel refused the previous exact pins.
- Data classes: items, claims and parties with their history are exported
  per tenant in bounded keyset pages inside the module's own transaction; no
  class is swept or erased; the idempotency ledgers of catalog and parties are
  excluded from the export with a stated reason because the approved specs
  call them durable replay evidence. Spec bullets added under `invariants`
  and `dataOwnership` under the owner's blanket approval; schemaVersion 1 is
  still accepted by the validator.
- Review records carry the new source digests; `release:pack --local`
  produced the three release artifacts and the local index.
- Gates in the official repository against the packed SDK: rules, typecheck,
  tests (expenses 54, catalog 35, parties 68, consumer 3), `module validate`,
  prettier.
- Acceptance in a fresh consumer app created by the SDK smoke (21 core
  modules): `module install` of the three releases from the local index,
  `module enable`, `module validate`, the app's `verify` (168 official module
  tests) and `build`, all exit 0.
- In this tree: `.ai/references/catalog` regenerated from the 0.7.0 artifact
  by `scripts/module-reference.mjs` (provenance pinned to `b8281b3`),
  `docs/module-distribution.md` names platform API 0.1.3.

Open: the official lockfile still resolves the 0.1.0 SDK, so its CI stays
red on `--frozen-lockfile` until the 0.2.4 packages are on npm and the
lockfile is regenerated; the owner deferred that publication. The first
commit's hunk split put a few data class spec bullets next to the version
changes; the content is right, the split is not clean.

One lesson repeated: a YAML scalar in a spec bullet with `: ` inside parses
as a mapping and fails the schema; three agents wrote such bullets and the
packer refused the release until they were rephrased.
