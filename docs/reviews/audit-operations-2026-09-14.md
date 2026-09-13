# Audit items 11, 12 and 13 review record (2026-09-14)

Scope: the three operations items the system audit of 2026-09-10 left open
and RFC 0005 recorded as decisions: #11 (a re-sealing pass for the storage
and connectors keys), #12 (a production restore path and point-in-time
recovery), #13 (the signed approval verifier the capability policy listed as
planned). The owner delegated the shape of each ("zrob to tak jak uwazasz").
Branch `feat/audit-ops` from the 0.3.0 release; three implementation
streams with disjoint ownership, three read-only reviewers, one fix round
each.

## What landed

- #13, signed approval grants (`packages/kernel/src/approval-grant.ts`):
  token `ag1.<keyId>.<canonical json>.<hmac>` signed with HMAC-SHA256 under
  `FD_APPROVAL_GRANT_KEY` (the previous key verifies, never signs), bound to
  the tenant, the capability id and the input digest, expiring one hour
  after the approving decision. `approvals.core` yields the token through
  `grant(tenantId, id, subjectModule)` for an approved request whose
  `subjectRef` encodes the capability and the digest, writes a `grant.issued`
  audit row (migration 0005), and never for pending, rejected, cancelled or
  expired requests. The CLI runner takes `--grant <token> --tenant <id>` and
  refuses external and non-local destructive capabilities without a valid
  one (`APPROVAL_VERIFIER_REQUIRED`, `APPROVAL_GRANT_INVALID`,
  `APPROVAL_GRANT_EXPIRED`, `APPROVAL_GRANT_MISMATCH`); the harness admits an
  external or destructive tool once per grant (`APPROVAL_GRANT_CONSUMED`
  afterwards), still runs the consent gate, and refuses `localOnly` CLI
  tools outside development and test (`TOOL_LOCAL_ONLY`). The CLI records no
  use, so a CLI grant replays until it expires; the spec and the runbook say
  so. The key is in the build script, both env examples, the backup
  fingerprints and the generator. Platform API 0.1.7.
- #11, re-sealing (`packages/storage/src/reseal.ts` and
  `resealStoredObject`): a frame is opened under the key its header names,
  re-sealed under the current key with the header's own AAD, and rewritten
  in place; unknown key ids, failed tags and corrupt headers are counted and
  left. `documents secrets-rotate`, `exports secrets-rotate` and
  `connectors secrets-rotate` drive the inventory from rows on the
  background lease (new policies by migrations 0003 in each module), page by
  primary key per tenant on the runtime lease with `FOR UPDATE` on apply,
  and both delete paths (documents remove, exports sweep) now lock the row
  before the object so a delete landing mid-pass leaves no orphan. The
  connectors fingerprint is recomputed under the current key while the
  plaintext is in hand.
- #12, production restore (`database restore-production`, capability
  `database.restore.production`): destructive, the same confirmation, no
  local gate, so it runs only under a grant bound to the exact flags;
  `--target` must equal the migrator DSN database, the migrator DSN must be
  a different user from the runtime DSN, a key mismatch is refused unless
  the approved invocation carried `--allow-key-mismatch`, and with `--apply`
  a health probe refuses while the platform answers (`PLATFORM_RUNNING`) or
  cannot be judged (`PLATFORM_STATE_UNKNOWN`) unless `--platform-stopped`
  attests it. PITR for the compose stack: WAL archiving into a second
  volume, `infra/docker/pitr.sh` with base backups and a recovery target,
  the limits of a plain-copy archive and the Kubernetes provider
  requirements in `infra/README.md`; the runbook gains "Restore in
  production", "Point-in-time recovery" and "Rehearsal".

## Review findings

- #13: 2 medium (no use recorded, so a grant replayed; the harness bypassed
  the localOnly gate for CLI tools), 3 low. Fixed; the CLI replay is stated
  rather than pretended away.
- #11: 2 medium (the runbook claimed a lock the delete paths did not take;
  the connectors dry run counted unknown keys as stale), 2 low. Fixed with
  the lock on both delete paths.
- #12: 1 medium (a DNS or TLS failure read as "platform stopped"), 5 low, 1
  info. Fixed.

## Modules and specs after the work

| Module          | Version | Spec hash (sha256, first 16) |
| --------------- | ------- | ---------------------------- |
| approvals.core  | 0.1.14  | `7456d8a6d8f5a924`           |
| connectors.core | 0.1.6   | `0c8fb2fc26a81421`           |
| documents.core  | 0.1.9   | `f5412b01d0b713ae`           |
| exports.core    | 0.2.3   | `136b3b19c2db0936`           |

Platform API 0.1.7 (`issueApprovalGrant`, `verifyApprovalGrant`,
`approvalInputDigest`, the storage re-seal surface). Every spec change is
under the owner's blanket approval: the grant invariant and scenario in
approvals, the rotation capabilities in documents, exports and connectors.

## Gates

Final run on 2026-09-14: typecheck, `spec validate`, `module validate`,
`capabilities:check`, `platform-api:check` (0.1.7), `format:check`,
`rules:check`, `reference:check`, `migration verify`: exit 0; `pnpm verify`
453 test files, 3945 tests passed, 3 skipped; PostgreSQL 17 with the CI
roles over twelve suites green (approvals 98, documents 89, exports 87,
connectors 148, cli 196 among them); `pnpm build`, `release:pack`,
`release:smoke` with the coding agent binaries hidden: exit 0, template
composition unchanged; `docker compose config` renders the WAL settings;
`bash -n infra/docker/pitr.sh` clean.

## Follow-ups

- A CLI grant is not consumed on use; recording use needs a platform
  connection the runner does not have. The approval window is the bound.
- PITR in the compose stack is a plain-copy WAL archive on the same host:
  no compression, no encryption, no off-site copy, no pruning; the README
  says so and names what a managed provider must offer in Kubernetes.
- `.ai/references/catalog` and the official modules still pin SDK 0.2.4
  until the 0.3.0 publication lands and the official repository is
  re-released.
