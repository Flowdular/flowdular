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
