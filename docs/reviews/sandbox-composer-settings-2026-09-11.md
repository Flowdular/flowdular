# Sandbox composer settings review

Scope: `ComposerSettings.tsrx`, its `ChatPane.tsrx` integration, sandbox CSS,
English and Polish locale entries, and `tests/browser/session-workflow.mjs`.

- Correctness: the icon-only Settings button precedes the attachment button in
  the composer row. The dropdown contains the existing automatic handoff and
  fresh-context controls. Browser assertions check ordering and vertical
  alignment, toggling both settings, persistence on reopening, and forwarding
  `freshContext: true` to the turn request. The existing submit reset and
  running-state disable rule remain in `ChatPane` and the new component.
- Security: this moves existing controls without adding server endpoints or
  changing authorization. `App.toggleAutoContinue` still calls the existing
  authenticated settings API and refreshes the session; errors retain the
  existing application alert. Fresh context uses the existing turn request.
  No database, tenancy, migration, network destination or secret handling changes.
- Compatibility: component-local props only; no public export, package dependency,
  module manifest or generated composition changes. English and Polish reuse
  existing option labels and add the matching Settings label.
- Lifecycle: pointer, focus, keyboard and resize listeners exist only while the
  dropdown is open and are removed on close or unmount. Escape restores trigger
  focus, outside interaction dismisses, and resizing closes stale positioning.
  Position calculation and state are constant-size; no polling or background work.
- UI: inspected desktop (1440 x 1000) and mobile (390 x 844) screenshots. The
  icon sits left of the plus button; both checkbox rows are contained above it.
  Shared button, icon, menu and checkbox primitives are used. Native checkboxes
  support Tab and Space; the trigger has an accessible name and expanded state.
  Existing empty, approval, failure and delivery scenarios in the browser suite
  still pass. No new asynchronous loading surface or denied state is introduced.
- Tests: browser regression passed with no page errors, including keyboard
  interaction, outside dismissal, request payload, mobile bounds and the
  existing workflow scenarios. API responses are synthetic; this proves the UI
  contract without invoking agents or changing the user's platform.

Validation:

- Browser: `node packages/sandbox/tests/browser/session-workflow.mjs http://127.0.0.1:4438`
  with the local Playwright module and Chrome executable. Passed.
  Artifacts: `/var/folders/t1/sqwgr805159fdpsthprc_y6r0000gn/T/sandbox-workflow-HmXbzs`.
- `pnpm build`: passed (`/tmp/composer-build.log`).
- `pnpm verify`: passed, including 261 sandbox tests (`/tmp/composer-verify.log`).
  Existing optional external PostgreSQL suites retain three environment-dependent
  skips; this change adds no skipped tests.

Verdict: pass. Full verification completed with no actionable finding
in the inspected diff. The Settings change is included in sandbox 0.2.7 alongside the runtime fixes
reviewed in `sandbox-progress-routing-preview-2026-09-11.md`.
