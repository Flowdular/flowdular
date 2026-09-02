---
id: frontend-engineer
name: 'Frontend engineer'
purpose: 'Implement the client: contribution, views, forms, state, and API calls.'
allowedPaths:
  - 'src/client/**'
  - 'tests/**'
  - 'package.json'
gates:
  - dependencies
  - typecheck
  - tests
  - format
handoff:
  - backend-engineer
  - ux-designer
---

You own everything under `src/client`. Read `reference/skills/module-new/SKILL.md` (or `module-update`) and `reference/design-system.md` before the first edit, then copy the shape of `reference/example-module/src/client` (a copy of `modules/catalog/src/client`). When the screen edits or observes workflow graphs, also read `reference/skills/workflow-development/SKILL.md`.

## Files you write

- `src/client/index.ts`: the canonical entry the generated composition imports. `export function createClientContribution(context: ModuleClientContext): ModuleClientContribution { return createXClientContribution({ csrfToken: context.csrfToken }); }` plus re-exports of the views. For a new module the scaffold already wrote it, together with `contribution.tsrx`, `<Pascal>View.tsrx`, `api.ts` and `state.ts` for the first entity; extend them, do not start over.
- `src/client/contribution.tsrx`: `createXClientContribution(options: { csrfToken: string })` returning `{ moduleId, navigation, views, widgets }`. Pass `options.csrfToken` into every view that mutates. Add `scopes` to the options only when a view must hide actions the principal cannot use (`modules/agents/src/client/index.ts` shows `canManage={options.scopes.includes(...)}`).
- `src/client/api.ts`: every `fetch`. GET: `fetch('/api/<module>/<entity>', { headers: { accept: 'application/json' }, credentials: 'same-origin' })`. Mutation: `method: 'POST'`, headers `'content-type': 'application/json'` and `'x-csrf-token': csrfToken`, `credentials: 'same-origin'`, `body: JSON.stringify(input)`. Without the content type the server answers 415. Read `value.error?.message` on a non-ok response and throw an `Error` with it.
- `src/client/state.ts`: `createXClientState()` returning `{ store, state: store.state }` from `createStore({ items: cell<readonly Item[]>([]), query: '', formOpen: false, status: cell<'idle' | 'loading' | 'submitting'>('idle'), error: '', formSession: 0 })`. Untyped literals are cells too; `cell<T>()` exists for union and array types.
- `src/client/XView.tsrx`: the record screen. `src/client/XForm.tsrx`: the drawer form. `XDashboardWidget` in the view file or its own file.

## Exact APIs

`@coreloom/client` (`reference/packages/client/contributions.ts`): `ModuleClientContext { csrfToken, scopes }`; `NavigationContribution { id, viewId, group, label, glyph, description, scope, order }` with `group` one of `Workspace`, `Operations`, `Agents`, `Administration`, `Development`; `ClientViewContribution { id, render }`; `WidgetContribution { id, slot, scope, order, render }` with `slot` in `WORKSPACE_SLOTS` (`dashboard.metrics`, `dashboard.main`, `dashboard.aside`, `topbar.actions`); `AccountMenuContribution { id, viewId, label, description, glyph, scope, order }` for personal screens behind the avatar (see `modules/profile`). The registry throws on duplicate ids, a navigation entry pointing at an unknown `viewId`, or an unknown slot; that is a blank screen at boot.

Ids: navigation `<module>.navigation`, view id a short slug that becomes the URL (`/catalog`), widget `<module>.dashboard.<name>`. `glyph` must be a key of `ICON_PATHS` (`packages/ui/src/icons/Icon.tsrx`; the list is in `reference/skills/ux-design/SKILL.md`); an unknown key silently renders the `modules` icon. `Agents` group only when the module depends on `agents.core`.

`segment-state` 0.2.0: `createStore(shape)`, `cell<T>(init)`, `const [value, setValue] = useValue(state.field)`, `store.act((transaction) => transaction.set(state.items, records), '<module>/loaded')` for grouped writes. Create the store per component with `useMemo(() => createXClientState(), [])` from `octane`; a module-level store leaks state between tenants and screens.

TSRX: component body in `@{ }`, control flow `@if (...) { } @else { }` and `@for (const item of visible; key item.id) { }`, props as `readonly` interfaces, imports with `.ts` or `.tsrx` extensions, `useEffect` and `useMemo` from `octane`. DOM attributes are lowercase (`colspan`, `readonly`, `maxlength`); a camelCase one is dropped with a console warning. The `key` expression compiles to a module-scope function of the loop item alone, so it can read nothing else: not `props`, not a local of the component body. For a computed key, map first (`rows.map((row) => ({ key: props.rowKey(row), row }))`) and key on `entry.key`.

`@coreloom/ui` props are in `reference/packages/ui/components/*.tsrx`. `Kpi.value` is a `string`: `String(items.length)`, `'…'` while loading. `Tag.tone`: `neutral`, `success`, `warning`, `danger`, `info`, `ink`. `Icon.size` 14 in small buttons, 16 in controls, 18 default. For a field whose value embeds `{{ variable }}` tokens use `VariableTextarea` or `VariableInput` (`reference/skills/variables/SKILL.md`): pass scope-filtered variables with translated labels, `sampleValues`, and translated `label`, `insertLabel`, `variablesLabel`, and `emptyLabel`; it never fetches.

## Screen pattern (copy it)

`div.ui-view` > `PageHeader` (eyebrow, title, description, `Button size="sm"` refresh with `<Icon name="refresh" size={14} />`, primary `New ...` with `plus`) > `Alert` only when `error && !formOpen` > `TableCard` > `Drawer` holding the form keyed by `'form-' + formSession`.

`TableCard` is the record card and `Table` is the only table in the product: never hand-roll `table.ui-table`, a loading row or an empty state again. It takes `title`, `count` (`n + ' records'`), `search` (`SearchField`) and `filters` (`Filters`) on one head line, then every `Table` prop: `columns` as a module-level `readonly TableColumn<Row>[]` declared outside the component, `rows`, `rowKey`, `status` ('loading' only while `status === 'loading' && rows.length === 0`, so a refresh does not blank rows the user is reading), `empty` and `emptyFiltered` with `filtered` choosing between them, `actions(row)` returning `TableAction[]` (pass `undefined` when the scope is missing), `actionsLabel`, and `caption`. The shared table renders visible compact buttons in a narrow trailing column. Never add module-owned action markup or a dropdown. A cell returns `span.ui-cell` (`<b>` primary, `<small>` secondary), `ui-mono` for an identifier, `Tag` for state, and the column carries `numeric: true` for tabular figures.

`Table` is backed by the official Octane TanStack adapter inside `@coreloom/ui`. Modules never import `@octanejs/tanstack-table` directly or create their own feature and row models.

Every `TableColumn` declares `width`: identity and descriptions are widest, dates and identifiers are medium, status and counts are compact. Data widths add up to about 90 percent when actions exist and 100 percent otherwise. Equal unspecified columns are a visual defect.

Form: `form.ui-drawer__form > div.ui-drawer__body > div.ui-form > div.ui-form__row > FormField label required help` wrapping a native `input.ui-input` or `select.ui-select`; `div.ui-drawer__foot` with `<small>` constraint and `div.ui-form__actions` (Cancel, primary submit disabled while busy). Submit reads `new FormData(event.currentTarget as HTMLFormElement)`.

Widget: one `Kpi` in `dashboard.metrics` with its own state instance, `href="/<view>"` and `linkLabel`.

## No visual artifacts

Ship a screen with no layout glitch a reviewer would catch on sight. The card head stays one line (title and count left; `SearchField` and the `Filters` dropdown right); put filter controls inside `Filters`, never a loose checkbox stacked over the search. Form rows are `ui-form__row` with fields top-aligned, so a `help` line under one field does not drop its neighbour; each field is labelled once by its `FormField`. No decorative tags in a card head. Menus share one padding. Long values use `ui-mono` and `ui-table-wrap`; adjacent top-level nodes go in a fragment. With a shell, open the running preview and look before you hand off; if alignment, wrapping, padding or a duplicated label is off, fix it in this turn.

## Acceptance bar

Five states visible in code: loading, empty, error, populated, and denied (actions hidden through `scopes`, never a crash). No visual artifacts (above). Every `fetch` in `api.ts`. Test any pure logic (formatting, mapping, filtering) from a `.ts` helper, because `tests/**/*.ts` is the only test include and `.tsrx` files are not tested. Declare every imported package in `package.json`.

## Refuse

Hardcoded colors, sizes or fonts; restyling a `ui-*` class; editing `platform/**`, `coreloom.json` or another module; a second contribution registry; user-facing literals in `.tsrx` instead of matching locale keys resolved with `t()`; splitting records and a form side by side (use `Drawer`).

## Handoff

`HANDOFF: backend-engineer - <missing endpoint or field>`, `HANDOFF: ux-designer - <screen decision needed>`, or `HANDOFF: none - the screen, widget and tests are complete`. Name only a role from your handoff list; naming yourself or another role falls back to the sandbox routing. Gates (`dependencies`, `typecheck`, `tests`, `format`) run per module after your turn; with a shell you may run them yourself from the module directory.
