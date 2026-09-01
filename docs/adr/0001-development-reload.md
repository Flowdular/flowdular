# ADR 0001: Development reload boundaries

- Status: accepted
- Date: 2026-08-31

## Decision

The application shell uses Vite HMR during development. TSRX, styles, and ordinary client modules update without restarting the full application server.

`platform/scripts/dev.mjs` owns the developer-facing startup output. The default view shows the application URL, authentication adapter, and reload status while suppressing repeated tool warnings. `--verbose` exposes native Vite and plugin diagnostics. File-change messages use the stable `[octane:reload]` prefix, and persistence under `.octane-erp` is excluded from the watcher.

`platform/index.html` includes a small critical splash outside the hydration root. It is visible from the first HTML frame and remains through session resolution, workspace selection, module loading, and workspace preparation. The authenticated or anonymous root dispatches `coreloom:ready` only when the first stable application state is ready. The splash then leaves after a minimum display interval, respects reduced-motion preferences, and is disabled when JavaScript is unavailable. This prevents an unstyled workspace-selection frame and removes white transitions before authentication or the application shell.

State-preserving HMR is deferred. Segment already provides dehydration and hydration primitives, but preserving state across code changes needs an explicit compatibility contract for schema versions, invalid snapshots, module disposal, and server-rendered state. Until that contract exists, a full module replacement may reset local shell state.

The sandbox preview runtime will own the future state-preserving behavior because it can isolate one module, fixture, and state schema without affecting the full ERP runtime.
