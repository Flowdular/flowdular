# Sidebar sections, dashboard metrics grid and the modules table (2026-09-15)

Three things the owner saw after 0.3.2 and asked to fix.

## Administration was one list of twenty screens

The `Administration` group collects every module's admin screen. With the
RFC 0002 to 0005 modules it holds twenty-one items, and a list that long
reads as noise. The fix keeps one group and gives it structure:

- `NavigationContribution.section` (optional, `NavigationSection`: `people`,
  `identity`, `compliance`, `integrations`, `platform`; platform API 0.1.10).
  The sidebar renders the group as labelled blocks in that order, items
  without a section last (`navigationSections`, tested in
  `packages/client/tests/navigation-sections.test.ts`).
- Every admin item of users, access, auth, directory, audit, notifications,
  connectors, system, metering and reports names its section; each module
  is a patch release. No spec changes: the group each screen belongs to is
  unchanged, the section is presentation.
- Administration starts folded. The group holding the active view always
  shows, so a deep link into Modules opens with its neighbours visible.

Sections as shipped: People and access (Users, Roles, Access review, Access
activity, Attestations); Identity and tokens (API tokens, Identity providers,
SCIM tokens, Groups, Provisioning log); Audit and data (Audit, Data classes,
Retention sweeps, Exports, Legal holds); Integrations (Webhooks, Deliveries,
Connectors, Connector calls); Platform (Settings, Modules, Usage, Limits,
Reports).

## Second pass: a context rail beside the sidebar

The owner tried two alternatives on screen. A rail of groups with a panel
of items (PR #26) moved the whole navigation behind an extra click and was
turned around the same day: the sidebar stays as it was, and the extra
column is contextual. A sectioned group (Administration) now shows one
entry per section in the sidebar (People and access, Identity and tokens,
Audit and data, Integrations, Platform), each opening its first screen.
While a sectioned view is open, a context rail (`ContextRail`, 220 px)
sits between the sidebar and the workspace with that section's screens,
and the workspace margin makes room for it; any other view has no rail. On
a phone the rail is hidden and the same screens nest under the section
entry in the drawer. Helpers `sectionOfView` and `sectionItems` are tested
in `packages/client/tests/state.test.ts`. The rail helpers of PR #26 stay
exported for the platform API surface and are unused. Platform API 0.1.13.

## The dashboard chart painted past its card

The Modules chart (Chart.js on a canvas) could keep a width measured while
the sidebar transition was still running and paint past the card edge. The
canvas box now clips (`overflow: hidden`, `min-width: 0`) and the canvas is
capped at its box width, so a late resize can only shrink it into place.

## The dashboard metrics row had holes

A metrics widget renders zero or several `Kpi` tiles (approvals hides at
zero, reports and metering answer up to three), but the slot wrapped each
widget in one grid cell. A widget with nothing to say left an empty cell and
a widget with two tiles stacked them in one. `.module-slot--metrics
.module-slot__item` is now `display: contents`, so every tile is a cell and
an empty widget leaves no hole. CSS only; the contribution contract is
unchanged.

## The modules table grew a row of eighteen ids

The dependents cell listed every dependent id. It now shows the count, the
first id and "and N more" (`dependentsSummary`, tested in
`modules/system/tests/module-columns.test.ts`), with the full list as the
cell's title.

## Not inspected in a browser

The Chrome extension was not connected in this session. Typecheck, the
client and module suites, validation, format and the capability card pass;
the owner's look at the sidebar and the dashboard is the visual check.
