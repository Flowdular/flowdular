# Setup onboarding review

Date: 2026-09-10. Verdict: pass. Scope: changes since 6363af2.

## Correctness and compatibility

- `packages/cli/src/setup-wizard.ts`, `index.ts` and generator `report.ts` provide bare interactive setup with local, PostgreSQL and check choices. Non-TTY and JSON calls retain configuration-check behavior. Wizard tests cover confirmation, cancellation, invalid URLs and existing database warnings.
- `module-import.ts`, `extensions.ts` and `migration.ts` load installed SDK TypeScript, including deferred imports. `installed-types.test.ts` reproduces the original Node failure, checks unrelated dependencies remain outside the loader, and proves broken migration imports propagate while absent optional files are skipped.
- `agent-resources.ts`, `doctor.ts`, `runner.ts` and the generated configuration resolve resources from the installed SDK. `doctor-consumer.test.ts` checks a consumer without authoring packages and still fails on a missing policy. Doctor output identifies individual failed checks.
- `database-pglite/src/driver.ts` creates nested durable directories and cleans up failed initialization. Three new durable-directory tests cover reopen persistence, directory failure and bootstrap cleanup. Generator secret encoding now matches auth's base64url contract, with deterministic byte-level regression coverage.
- Public versions are SDK, CLI and generator 0.2.1, sandbox 0.2.2 with SDK 0.2.1. The packer produced exactly four packages. No module specification, endpoint, permission, tenant contract or applied migration SQL changed.

## Security and lifecycle

- The local wizard previews through the existing runner, defaults confirmation to no, warns that all existing local data is deleted, requires a stopped application and refuses custom or hosted database settings. Tests verify refusal never reaches apply. Existing runner reset guards remain authoritative.
- PostgreSQL input is masked, bounded and validated; TLS verification and separate migration credentials use the database provider's production validation. The wizard only saves configuration and does not connect to or reset a hosted database. Tests assert credentials are absent from the returned envelope.
- `setup-environment.ts` preserves unrelated settings, writes with mode 0600, rejects symlinks and stale contents, and serializes cooperating writers using an exclusive lock. Tests exercise stale saves, symlinks and concurrent writes. Cancellation before confirmation leaves data unchanged. Abrupt process termination can leave `.env.setup.lock`; recovery requires checking that no setup process remains before removing that lock.
- File processing is linear in environment-file size. The loader retains one root set for the CLI process and checks O(number of selected roots) per TypeScript load. PGlite initialization failures close created instances; disposal no longer masks the original error. The HTTP smoke test bounds logs and readiness and terminates its owned server.
- Authentication and tenancy behavior is unchanged. Existing full-suite security tests remain enabled; the new packaged integration authenticates the seeded owner through the actual HTTP endpoint.

## Executable evidence

All commands used Node 24.18.0:

- Scoped regression tests passed; relevant full-suite totals: CLI 114, generator 34, PGlite 15 tests.
- `pnpm verify`: passed, including typechecks, tests, validation and formatting.
- `pnpm build`: passed, including CLI smoke and platform build.
- `pnpm release:pack`: passed, exactly four public packages.
- `pnpm release:smoke`: passed in an isolated consumer installed from tarballs. Doctor, blueprints, setup preview and apply, module checks, application HTTP login and standalone sandbox integration passed.
- Real terminal inspection exercised keyboard selection, default refusal and confirmed local initialization in an owned temporary application. PostgreSQL behavior is covered by injected-prompt tests; no hosted database was contacted.
- Original installed-type, doctor, directory and MFA regressions were observed failing before their fixes. An initial HTTP smoke assertion expected branding in a pending SSR response; it was corrected to check actual hydration markup and successful authentication, without weakening application behavior assertions.

Local logs: `/tmp/setup-final-verify.log`, `/tmp/setup-final-build.log`, `/tmp/setup-final-pack.log`, `/tmp/setup-final-smoke.log`.

## Delivery limits

No actionable findings remain. This review is an assessment, not a guarantee. npm publication has not run. Existing apps need updated dependencies and the corrected SDK resource configuration. The user's `blog` received configuration-path fixes and equivalent MFA-key encoding; only doctor and reset preview ran against it, with no database reset.
