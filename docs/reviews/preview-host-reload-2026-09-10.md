# Preview host reload review

Verdict: pass. Base: 82ef250.

The process-owned preview runtime can outlive the Vite SSR runner that imported its host database implementation. `database-pglite/src/driver.ts` previously imported mkdir dynamically when the database was first opened; Vite bound that import to the expired runner. Moving the built-in import to module initialization removes the stale dependency without changing database ownership, paths, isolation, leases or worker permissions.

`packages/sandbox/tests/preview-host-reload.test.ts` loads the actual preview database provider with a Vite SSR runner, closes the runner, then acquires a migration lease and executes SELECT 42. It failed with the reported Vite module runner has been closed message before the change and passes afterward. Its provider, Vite server and temporary files are released. No mock bypasses the failing boundary. The package remains server-only; consumer browser-boundary smoke passes. No new loop, retained resource, public API or migration was introduced.

The generated development launcher now uses the existing SDK dev-console module, as the platform and sandbox already do. Quiet mode groups tool warnings behind a notice; --verbose, -v and FD_DEV_VERBOSE restore diagnostics. Errors remain visible through the shared logger. The console bridge is restored on startup failure and server shutdown. The existing blog launcher was updated only after confirming it matched the old template. Its running process and sandbox draft were not interrupted or rewritten.

An isolated application's generated launcher started successfully in quiet and verbose modes. The quiet response rendered its authentication page without sourcemap log spam. This is presentation handling, not a repair to the upstream segment-state sourcemaps. No UI component or locale copy changed in this patch.

Scoped regression and typechecks passed, followed by pnpm verify, pnpm build, pnpm release:pack and pnpm release:smoke. The packed consumer passed setup, authenticated owner checks, isolated sandbox composition, HTTP/SSR and font downloads. Logs: /tmp/preview-host-before.log, /tmp/preview-reload-verify.log, /tmp/preview-reload-build.log, /tmp/preview-reload-pack.log and /tmp/preview-reload-smoke.log.

Reviewed release versions: SDK and CLI 0.2.3; generator and sandbox 0.2.4. No actionable findings remain. A restart using the new sandbox package is required to replace already-loaded code. Review is an assessment, not a correctness guarantee.
