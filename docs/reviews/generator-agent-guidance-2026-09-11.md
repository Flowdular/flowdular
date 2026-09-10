# Generated application agent guidance review

Release: `create-flowdular@0.2.5`. SDK and CLI versions are unchanged.

## Requirements and implementation

A fresh application must contain usable project-local agent guidance before
installing dependencies. `generator-agent-template.mjs` builds a separate bundled
tree from explicit canonical `.ai` directories, supporting guides and RuleSync
configuration. It generates Codex/Claude instructions from those rules and skills.
`scaffold.ts` validates this bundled tree before writing and copies it alongside
the application template, including in no-install mode.

The application owns its policy and blueprint paths. RuleSync is pinned to the
repository version, generation/check scripts are present, and verify detects
instruction drift. Public SDK imports are rewritten without rewriting workspace
package selectors. Application guidance explains the installed SDK boundary and
maps change types to skills, files and executable checks. The existing 19 task
skills remain the procedure set. The new map makes their application context
explicit without inventing new roles or granting wider sandbox write paths.

## Review checks

- Correctness: `scaffold.test.ts` asserts the generated `.ai`, role prompts,
  reference module, guide, AGENTS/CLAUDE files and both tool skill directories.
  It checks SDK imports and project-local policy paths. Before implementation,
  the new file assertion failed (`/tmp/generator-agents-red.log`); all 34 generator
  tests now pass (`/tmp/generator-agents-green-final.log`). Packed-consumer smoke
  checks those files before install, RuleSync parity, doctor, validation, setup,
  application startup, tests and production build.
- Security: no personal `.claude` settings, credentials, transcripts or `.env`
  are copied from the developer workspace. Inputs explicitly name public source
  directories; tool-specific files are freshly generated. Both scaffold and
  packed-consumer checks assert local Claude settings are absent. Existing
  generated-secret and nonempty-destination tests remain active. Reference
  artifacts remain byte-identical. No endpoint, permission or database contract
  changes. The app build uses the existing isolated-state build wrapper with
  temporary keys, so it does not consume deployment database settings.
- Compatibility: generator flags and destination checks are unchanged. The
  agent bundle is present in npm files and needs neither Git nor network at
  scaffold time. Build/dev/test generate it from repository sources, and release
  packing runs that build. The installed SDK and CLI dependencies remain 0.2.3.
  Changes to existing apps require an explicit update; this release does not
  overwrite their local guidance. Existing --force overwrite semantics remain.
- Lifecycle and cost: preparation/copy is O(total bundled bytes), with one source
  file processed at a time. No background job or watcher is added. The generated
  bundle is ignored by Git and rebuilt from canonical inputs. Build generation
  rejects missing inputs and nonzero RuleSync execution. Runtime copying rejects
  symlinks and paths outside the destination through existing template checks.
- UI: no rendered UI or interactive input handling changed. Documentation now
  names actual application locations and commands. Terminal generator output
  and onboarding remain as before, with an updated generated file count.

## Validation

- Generator suite: 34 passed. Generator typecheck and build passed.
- Initial packed-consumer verification reached formatting and rejected the smoke
  fixture's appended tarball overrides in pnpm-workspace.yaml. The smoke now
  formats that modified fixture file only; product formatting checks stay active.
- Initial repository verification exposed a doctor fixture that assumed only SDK
  policy paths. It now tests both local and SDK layouts, including missing-policy
  denial; both tests pass (`/tmp/generator-doctor-check.log`).
- Review found missing ADRs referenced by workflow and agent skills. The bundle
  now includes docs/adr, with scaffold assertions for the relevant documents.
- Final `pnpm verify` and `pnpm build`: passed
  (`/tmp/generator-agents-verify-final.log`, `/tmp/generator-platform-build.log`).
- Packed application verify passed, then build exposed that the starter did not
  honor the isolated-build environment contract. Its configuration now uses the
  existing build flag for temporary PGlite, skips runtime activation and releases
  build resources. Production startup keeps its original adapter checks.
- Final repeated `pnpm verify` and `pnpm build`: passed
  (`/tmp/sdk-reference-verify.log`, `/tmp/sdk-reference-build.log`).
- Final packed-consumer smoke after that fix: passed
  (`/tmp/sdk-reference-smoke.log`), including a generated app verify, isolated
  production build, application startup and independently installed sandbox.

No actionable code finding. Final review verdict: pass. Source checks and packed release validation passed.
